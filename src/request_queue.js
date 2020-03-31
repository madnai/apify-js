import * as crypto from 'crypto';
import { checkParamOrThrow } from 'apify-client/build/utils';
import * as LruCache from 'apify-shared/lru_cache';
import * as ListDictionary from 'apify-shared/list_dictionary';
import { ENV_VARS, LOCAL_ENV_VARS, LOCAL_STORAGE_SUBDIRS, REQUEST_QUEUE_HEAD_MAX_LIMIT } from 'apify-shared/consts';
import { checkParamPrototypeOrThrow, cryptoRandomObjectId } from 'apify-shared/utilities';
import log from './utils_log';
import Request, { RequestOptions } from './request'; // eslint-disable-line import/named,no-unused-vars
import { apifyClient, getApifyStorageLocal, ensureTokenOrLocalStorageEnvExists, sleep } from './utils';

export const LOCAL_STORAGE_SUBDIR = LOCAL_STORAGE_SUBDIRS.requestQueues;
const MAX_OPENED_QUEUES = 1000;
const MAX_CACHED_REQUESTS = 1000 * 1000;

// When requesting queue head we always fetch requestsInProgressCount * QUERY_HEAD_BUFFER number of requests.
export const QUERY_HEAD_MIN_LENGTH = 100;
export const QUERY_HEAD_BUFFER = 3;

// If queue was modified (request added/updated/deleted) before more than API_PROCESSED_REQUESTS_DELAY_MILLIS
// then we assume the get head operation to be consistent.
export const API_PROCESSED_REQUESTS_DELAY_MILLIS = 10 * 1000;

// How many times we try to get queue head with queueModifiedAt older than API_PROCESSED_REQUESTS_DELAY_MILLIS.
export const MAX_QUERIES_FOR_CONSISTENCY = 6;

// This number must be large enough so that processing of all these requests cannot be done in
// a time lower than expected maximum latency of DynamoDB, but low enough not to waste too much memory.
const RECENTLY_HANDLED_CACHE_SIZE = 1000;

// Indicates how long it usually takes for the underlying storage to propagate all writes
// to be available to subsequent reads.
export const STORAGE_CONSISTENCY_DELAY_MILLIS = 3000;

export const queuesCache = new LruCache({ maxLength: MAX_OPENED_QUEUES }); // Open queues are stored here.

/**
 * Helper function to validate params of *.addRequest().
 * @ignore
 */
const validateAddRequestParams = (request, opts) => {
    checkParamOrThrow(request, 'request', 'Object');
    checkParamOrThrow(opts, 'opts', 'Object');

    const newRequest = request instanceof Request ? request : new Request(request);

    const { forefront = false } = opts;

    checkParamOrThrow(forefront, 'opts.forefront', 'Boolean');

    if (request.id) throw new Error('Request already has the "id" field set so it cannot be added to the queue!');

    return { forefront, newRequest };
};

/**
 * Helper function to validate params of *.getRequest().
 * @ignore
 */
const validateGetRequestParams = (requestId) => {
    checkParamOrThrow(requestId, 'requestId', 'String');
};

/**
 * Helper function to validate params of *.markRequestHandled().
 * @ignore
 */
const validateMarkRequestHandledParams = (request) => {
    checkParamPrototypeOrThrow(request, 'request', Request, 'Apify.Request');
    checkParamOrThrow(request.id, 'request.id', 'String');
};

/**
 * Helper function to validate params of *.reclaimRequest().
 * @ignore
 */
const validateReclaimRequestParams = (request, opts) => {
    checkParamPrototypeOrThrow(request, 'request', Request, 'Apify.Request');
    checkParamOrThrow(request.id, 'request.id', 'String');
    checkParamOrThrow(opts, 'opts', 'Object');

    const { forefront = false } = opts;

    checkParamOrThrow(forefront, 'opts.forefront', 'Boolean');

    return { forefront };
};

/**
 * Helper function that creates ID from uniqueKey for local emulation of request queue.
 * It's also used for local cache of remote request queue.
 *
 * This function may not exactly match how requestId is created server side.
 * So we never pass requestId created by this to server and use it only for local cache.
 *
 * @ignore
 */
export const getRequestId = (uniqueKey) => {
    checkParamOrThrow(uniqueKey, 'uniqueKey', 'String');

    const str = crypto
        .createHash('sha256')
        .update(uniqueKey)
        .digest('base64')
        .replace(/(\+|\/|=)/g, '');

    return str.substr(0, 15);
};

/**
 * A helper class that is used to report results from various
 * {@link RequestQueue} functions as well as
 * {@link utils#enqueueLinks}.
 *
 * @typedef QueueOperationInfo
 * @property {boolean} wasAlreadyPresent Indicates if request was already present in the queue.
 * @property {boolean} wasAlreadyHandled Indicates if request was already marked as handled.
 * @property {string} requestId The ID of the added request
 * @property {Request} request The original {@link Request} object passed to the `RequestQueue` function.
 */

/**
 * Represents a queue of URLs to crawl, which is used for deep crawling of websites
 * where you start with several URLs and then recursively
 * follow links to other pages. The data structure supports both breadth-first and depth-first crawling orders.
 *
 * Each URL is represented using an instance of the {@link Request} class.
 * The queue can only contain unique URLs. More precisely, it can only contain {@link Request} instances
 * with distinct `uniqueKey` properties. By default, `uniqueKey` is generated from the URL, but it can also be overridden.
 * To add a single URL multiple times to the queue,
 * corresponding {@link Request} objects will need to have different `uniqueKey` properties.
 *
 * Do not instantiate this class directly, use the
 * {@link Apify#openRequestQueue} function instead.
 *
 * `RequestQueue` is used by {@link BasicCrawler}, {@link CheerioCrawler}
 * and {@link PuppeteerCrawler} as a source of URLs to crawl.
 * Unlike {@link RequestList}, `RequestQueue` supports dynamic adding and removing of requests.
 * On the other hand, the queue is not optimized for operations that add or remove a large number of URLs in a batch.
 *
 * `RequestQueue` stores its data either on local disk or in the Apify Cloud,
 * depending on whether the `APIFY_LOCAL_STORAGE_DIR` or `APIFY_TOKEN` environment variable is set.
 *
 * If the `APIFY_LOCAL_STORAGE_DIR` environment variable is set, the queue data is stored in
 * that directory in an SQLite database file.
 *
 * If the `APIFY_TOKEN` environment variable is set but `APIFY_LOCAL_STORAGE_DIR` is not, the data is stored in the
 * [Apify Request Queue](https://docs.apify.com/storage/request-queue)
 * cloud storage. Note that you can force usage of the cloud storage also by passing the `forceCloud`
 * option to {@link Apify#openRequestQueue} function,
 * even if the `APIFY_LOCAL_STORAGE_DIR` variable is set.
 *
 * **Example usage:**
 *
 * ```javascript
 * // Open the default request queue associated with the actor run
 * const queue = await Apify.openRequestQueue();
 *
 * // Open a named request queue
 * const queueWithName = await Apify.openRequestQueue('some-name');
 *
 * // Enqueue few requests
 * await queue.addRequest({ url: 'http://example.com/aaa' });
 * await queue.addRequest({ url: 'http://example.com/bbb' });
 * await queue.addRequest({ url: 'http://example.com/foo/bar' }, { forefront: true });
 * ```
 * @hideconstructor
 */
export class RequestQueue {
    /**
     * @param {object} options
     * @param {string} options.id
     * @param {string} [options.name]
     * @param {object} [options.storageClient]
     * @param {boolean} [options.isLocal]
     * @param {string} [options.clientKey]
     */
    constructor(options) {
        const {
            id,
            name,
            storageClient = apifyClient.requestQueues,
            isLocal = false,
            clientKey = cryptoRandomObjectId(),
        } = options;

        checkParamOrThrow(id, 'id', 'String');
        checkParamOrThrow(name, 'name', 'Maybe String');
        checkParamOrThrow(storageClient, 'storageClient', 'Object');
        checkParamOrThrow(isLocal, 'isLocal', 'Boolean');
        checkParamOrThrow(clientKey, 'clientKey', 'String');

        if (!clientKey) throw new Error('Parameter "clientKey" must be a non-empty string!');

        this.clientKey = clientKey;
        this.queueId = id;
        this.queueName = name;
        this.client = storageClient;
        this.isLocal = isLocal;

        // Contains a cached list of request IDs from the head of the queue,
        // as obtained in the last query. Both key and value is the request ID.
        // Need to apply a type here to the generated TS types don't try to use types-apify
        /**
         * @type {*}
         * @ignore
         */
        this.queueHeadDict = new ListDictionary();
        this.queryQueueHeadPromise = null;

        // A set of all request IDs that are currently being handled,
        // i.e. which were returned by fetchNextRequest() but not markRequestHandled()
        this.inProgress = new Set();

        // Contains a list of recently handled requests. It is used to avoid inconsistencies
        // caused by delays in the underlying DynamoDB storage.
        // Keys are request IDs, values are true.
        this.recentlyHandled = new LruCache({ maxLength: RECENTLY_HANDLED_CACHE_SIZE });

        // We can trust these numbers only in a case that queue is used by a single client.
        // This information is returned by getHead() under the hadMultipleClients property.
        this.assumedTotalCount = 0;
        this.assumedHandledCount = 0;

        // Caching requests to avoid redundant addRequest() calls.
        // Key is computed using getRequestId() and value is { id, isHandled }.
        // TODO: We could extend the caching to improve performance
        //       of other operations such as fetchNextRequest().
        this.requestsCache = new LruCache({ maxLength: MAX_CACHED_REQUESTS });
    }

    /**
     * @ignore
     */
    inProgressCount() {
        return this.inProgress.size;
    }

    /**
     * Adds a request to the queue.
     *
     * If a request with the same `uniqueKey` property is already present in the queue,
     * it will not be updated. You can find out whether this happened from the resulting
     * {@link QueueOperationInfo} object.
     *
     * To add multiple requests to the queue by extracting links from a webpage,
     * see the {@link utils#enqueueLinks} helper function.
     *
     * @param {(Request|RequestOptions)} request {@link Request} object or vanilla object with request data.
     * Note that the function sets the `uniqueKey` and `id` fields to the passed object.
     * @param {Object} [options]
     * @param {boolean} [options.forefront=false] If `true`, the request will be added to the foremost position in the queue.
     * @return {Promise<QueueOperationInfo>}
     */
    async addRequest(request, options = {}) {
        const { newRequest, forefront } = validateAddRequestParams(request, options);

        request.uniqueKey = newRequest.uniqueKey;

        const cacheKey = getRequestId(newRequest.uniqueKey);
        const cachedInfo = this.requestsCache.get(cacheKey);

        if (cachedInfo) {
            request.id = cachedInfo.id;
            return {
                wasAlreadyPresent: true,
                // We may assume that if request is in local cache then also the information if the
                // request was already handled is there because just one client should be using one queue.
                wasAlreadyHandled: cachedInfo.isHandled,
                requestId: cachedInfo.id,
                request,
            };
        }

        const queueOperationInfo = await this.client.addRequest({
            request: newRequest,
            queueId: this.queueId,
            forefront,
            clientKey: this.clientKey,
        });

        const { requestId, wasAlreadyPresent } = queueOperationInfo;

        this._cacheRequest(cacheKey, queueOperationInfo);

        if (!wasAlreadyPresent && !this.inProgress.has(requestId) && !this.recentlyHandled.get(requestId)) {
            this.assumedTotalCount++;

            // Performance optimization: add request straight to head if possible
            this._maybeAddRequestToQueueHead(requestId, forefront);
        }

        request.id = requestId;
        queueOperationInfo.request = request;

        return queueOperationInfo;
    }

    /**
     * Gets the request from the queue specified by ID.
     *
     * @param {string} requestId ID of the request.
     * @return {Promise<(Request | null)>} Returns the request object, or `null` if it was not found.
     */
    async getRequest(requestId) {
        validateGetRequestParams(requestId);

        // TODO: Could we also use requestsCache here? It would be consistent with addRequest()
        // Downside is that it wouldn't reflect changes from outside...
        const obj = await this.client.getRequest({
            requestId,
            queueId: this.queueId,
        });

        return obj ? new Request(obj) : null;
    }

    /**
     * Returns a next request in the queue to be processed, or `null` if there are no more pending requests.
     *
     * Once you successfully finish processing of the request, you need to call
     * {@link RequestQueue#markRequestHandled}
     * to mark the request as handled in the queue. If there was some error in processing the request,
     * call {@link RequestQueue#reclaimRequest} instead,
     * so that the queue will give the request to some other consumer in another call to the `fetchNextRequest` function.
     *
     * Note that the `null` return value doesn't mean the queue processing finished,
     * it means there are currently no pending requests.
     * To check whether all requests in queue were finished,
     * use {@link RequestQueue#isFinished} instead.
     *
     * @returns {Promise<(Request|null)>}
     * Returns the request object or `null` if there are no more pending requests.
     */
    async fetchNextRequest() {
        await this._ensureHeadIsNonEmpty();

        const nextRequestId = this.queueHeadDict.removeFirst();

        // We are likely done at this point.
        if (!nextRequestId) return null;

        // This should never happen, but...
        if (this.inProgress.has(nextRequestId) || this.recentlyHandled.get(nextRequestId)) {
            log.warning('Queue head returned a request that is already in progress?!', {
                nextRequestId,
                inProgress: this.inProgress.has(nextRequestId),
                recentlyHandled: !!this.recentlyHandled.get(nextRequestId),
            });
            return null;
        }

        this.inProgress.add(nextRequestId);

        let request;
        try {
            request = await this.getRequest(nextRequestId);
        } catch (e) {
            // On error, remove the request from in progress, otherwise it would be there forever
            this.inProgress.delete(nextRequestId);
            throw e;
        }

        // NOTE: It can happen that the queue head index is inconsistent with the main queue table. This can occur in two situations:

        // 1) Queue head index is ahead of the main table and the request is not present in the main table yet (i.e. getRequest() returned null).
        //    In this case, keep the request marked as in progress for a short while,
        //    so that isFinished() doesn't return true and _ensureHeadIsNonEmpty() doesn't not load the request
        //    into the queueHeadDict straight again. After the interval expires, fetchNextRequest()
        //    will try to fetch this request again, until it eventually appears in the main table.
        if (!request) {
            log.debug('Cannot find a request from the beginning of queue, will be retried later', { nextRequestId });
            setTimeout(() => {
                this.inProgress.delete(nextRequestId);
            }, STORAGE_CONSISTENCY_DELAY_MILLIS);
            return null;
        }

        // 2) Queue head index is behind the main table and the underlying request was already handled
        //    (by some other client, since we keep the track of handled requests in recentlyHandled dictionary).
        //    We just add the request to the recentlyHandled dictionary so that next call to _ensureHeadIsNonEmpty()
        //    will not put the request again to queueHeadDict.
        if (request.handledAt) {
            log.debug('Request fetched from the beginning of queue was already handled', { nextRequestId });
            this.recentlyHandled.add(nextRequestId, true);
            return null;
        }

        return request;
    }

    /**
     * Marks a request that was previously returned by the
     * {@link RequestQueue#fetchNextRequest}
     * function as handled after successful processing.
     * Handled requests will never again be returned by the `fetchNextRequest` function.
     *
     * @param {Request} request
     * @return {Promise<QueueOperationInfo>}
     */
    async markRequestHandled(request) {
        // TODO: This function should also support object instead of Apify.Request()
        validateMarkRequestHandledParams(request);

        if (!this.inProgress.has(request.id)) {
            throw new Error(`Cannot mark request ${request.id} as handled, because it is not in progress!`);
        }

        if (!request.handledAt) request.handledAt = new Date();

        const queueOperationInfo = await this.client.updateRequest({
            request,
            queueId: this.queueId,
            clientKey: this.clientKey,
        });

        this.inProgress.delete(request.id);
        this.recentlyHandled.add(request.id, true);

        if (!queueOperationInfo.wasAlreadyHandled) {
            this.assumedHandledCount++;
        }

        this._cacheRequest(getRequestId(request.uniqueKey), queueOperationInfo);

        queueOperationInfo.request = request;

        return queueOperationInfo;
    }

    /**
     * Reclaims a failed request back to the queue, so that it can be returned for processed later again
     * by another call to {@link RequestQueue#fetchNextRequest}.
     * The request record in the queue is updated using the provided `request` parameter.
     * For example, this lets you store the number of retries or error messages for the request.
     *
     * @param {Request} request
     * @param {Object} [options]
     * @param {boolean} [options.forefront=false]
     * If `true` then the request it placed to the beginning of the queue, so that it's returned
     * in the next call to {@link RequestQueue#fetchNextRequest}.
     * By default, it's put to the end of the queue.
     * @return {Promise<QueueOperationInfo>}
     */
    async reclaimRequest(request, options = {}) {
        // TODO: This function should also support object instead of Apify.Request()
        const { forefront } = validateReclaimRequestParams(request, options);

        if (!this.inProgress.has(request.id)) {
            throw new Error(`Cannot reclaim request ${request.id}, because it is not in progress!`);
        }

        // TODO: If request hasn't been changed since the last getRequest(),
        // we don't need to call updateRequest() and thus improve performance.

        const queueOperationInfo = await this.client.updateRequest({
            request,
            queueId: this.queueId,
            forefront,
            clientKey: this.clientKey,
        });

        this._cacheRequest(getRequestId(request.uniqueKey), queueOperationInfo);
        queueOperationInfo.request = request;

        // Wait a little to increase a chance that the next call to fetchNextRequest() will return the request with updated data.
        // This is to compensate for the limitation of DynamoDB, where writes might not be immediately visible to subsequent reads.
        setTimeout(() => {
            if (!this.inProgress.has(request.id)) {
                log.warning('The request is no longer marked as in progress in the queue?!', { requestId: request.id });
                return;
            }

            this.inProgress.delete(request.id);

            // Performance optimization: add request straight to head if possible
            this._maybeAddRequestToQueueHead(request.id, forefront);
        }, STORAGE_CONSISTENCY_DELAY_MILLIS);

        return queueOperationInfo;
    }

    /**
     * Resolves to `true` if the next call to {@link RequestQueue#fetchNextRequest}
     * would return `null`, otherwise it resolves to `false`.
     * Note that even if the queue is empty, there might be some pending requests currently being processed.
     * If you need to ensure that there is no activity in the queue, use {@link RequestQueue#isFinished}.
     *
     * @returns {Promise<boolean>}
     */
    async isEmpty() {
        await this._ensureHeadIsNonEmpty();
        return this.queueHeadDict.length() === 0;
    }

    /**
     * Resolves to `true` if all requests were already handled and there are no more left.
     * Due to the nature of distributed storage used by the queue,
     * the function might occasionally return a false negative,
     * but it will never return a false positive.
     *
     * @returns {Promise<boolean>}
     */
    async isFinished() {
        if (this.queueHeadDict.length() > 0 || this.inProgressCount() > 0) return false;

        const isHeadConsistent = await this._ensureHeadIsNonEmpty(true);
        return isHeadConsistent && this.queueHeadDict.length() === 0 && this.inProgressCount() === 0;
    }

    /**
     * Caches information about request to beware of unneeded addRequest() calls.
     *
     * @ignore
     */
    _cacheRequest(cacheKey, queueOperationInfo) {
        checkParamOrThrow(cacheKey, 'cacheKey', 'String');
        checkParamOrThrow(queueOperationInfo, 'queueOperationInfo', 'Object');
        checkParamOrThrow(queueOperationInfo.requestId, 'queueOperationInfo.requestId', 'String');
        checkParamOrThrow(queueOperationInfo.wasAlreadyHandled, 'queueOperationInfo.wasAlreadyHandled', 'Boolean');

        this.requestsCache.add(cacheKey, {
            id: queueOperationInfo.requestId,
            isHandled: queueOperationInfo.wasAlreadyHandled,
        });
    }

    /**
     * We always request more items than is in progress to ensure that something falls into head.
     *
     * @param {boolean} [ensureConsistency=false] If true then query for queue head is retried until queueModifiedAt
     *   is older than queryStartedAt by at least API_PROCESSED_REQUESTS_DELAY_MILLIS to ensure that queue
     *   head is consistent.
     * @param {number} [limit] How many queue head items will be fetched.
     * @param {number} [iteration] Used when this function is called recursively to limit the recursion.
     * @return {Promise<boolean>} Indicates if queue head is consistent (true) or inconsistent (false).
     * @ignore
     */
    async _ensureHeadIsNonEmpty(
        ensureConsistency = false,
        limit = Math.max(this.inProgressCount() * QUERY_HEAD_BUFFER, QUERY_HEAD_MIN_LENGTH),
        iteration = 0,
    ) {
        checkParamOrThrow(ensureConsistency, 'ensureConsistency', 'Boolean');
        checkParamOrThrow(limit, 'limit', 'Number');
        checkParamOrThrow(iteration, 'iteration', 'Number');

        // If is nonempty resolve immediately.
        if (this.queueHeadDict.length() > 0) return true;

        if (!this.queryQueueHeadPromise) {
            const queryStartedAt = new Date();

            this.queryQueueHeadPromise = this.client
                .getHead({
                    limit,
                    queueId: this.queueId,
                    clientKey: this.clientKey,
                })
                .then(({ items, queueModifiedAt, hadMultipleClients }) => {
                    items.forEach(({ id: requestId, uniqueKey }) => {
                        // Queue head index might be behind the main table, so ensure we don't recycle requests
                        if (this.inProgress.has(requestId) || this.recentlyHandled.get(requestId)) return;

                        this.queueHeadDict.add(requestId, requestId, false);
                        this._cacheRequest(getRequestId(uniqueKey), { requestId, wasAlreadyHandled: false });
                    });

                    // This is needed so that the next call to _ensureHeadIsNonEmpty() will fetch the queue head again.
                    this.queryQueueHeadPromise = null;

                    return {
                        wasLimitReached: items.length >= limit,
                        prevLimit: limit,
                        queueModifiedAt: new Date(queueModifiedAt),
                        queryStartedAt,
                        hadMultipleClients,
                    };
                });
        }

        const { queueModifiedAt, wasLimitReached, prevLimit, queryStartedAt, hadMultipleClients } = await this.queryQueueHeadPromise;

        // TODO: I feel this code below can be greatly simplified...

        // If queue is still empty then one of the following holds:
        // - the other calls waiting for this promise already consumed all the returned requests
        // - the limit was too low and contained only requests in progress
        // - the writes from other clients were not propagated yet
        // - the whole queue was processed and we are done

        // If limit was not reached in the call then there are no more requests to be returned.
        if (prevLimit >= REQUEST_QUEUE_HEAD_MAX_LIMIT) {
            log.warning(`RequestQueue: Reached the maximum number of requests in progress: ${REQUEST_QUEUE_HEAD_MAX_LIMIT}.`);
        }
        const shouldRepeatWithHigherLimit = this.queueHeadDict.length() === 0
            && wasLimitReached
            && prevLimit < REQUEST_QUEUE_HEAD_MAX_LIMIT;

        // If ensureConsistency=true then we must ensure that either:
        // - queueModifiedAt is older than queryStartedAt by at least API_PROCESSED_REQUESTS_DELAY_MILLIS
        // - hadMultipleClients=false and this.assumedTotalCount<=this.assumedHandledCount
        const isDatabaseConsistent = queryStartedAt - queueModifiedAt >= API_PROCESSED_REQUESTS_DELAY_MILLIS;
        const isLocallyConsistent = !hadMultipleClients && this.assumedTotalCount <= this.assumedHandledCount;
        // Consistent information from one source is enough to consider request queue finished.
        const shouldRepeatForConsistency = ensureConsistency && !isDatabaseConsistent && !isLocallyConsistent;

        // If both are false then head is consistent and we may exit.
        if (!shouldRepeatWithHigherLimit && !shouldRepeatForConsistency) return true;

        // If we are querying for consistency then we limit the number of queries to MAX_QUERIES_FOR_CONSISTENCY.
        // If this is reached then we return false so that empty() and finished() returns possibly false negative.
        if (!shouldRepeatWithHigherLimit && iteration > MAX_QUERIES_FOR_CONSISTENCY) return false;

        const nextLimit = shouldRepeatWithHigherLimit
            ? Math.round(prevLimit * 1.5)
            : prevLimit;

        // If we are repeating for consistency then wait required time.
        if (shouldRepeatForConsistency) {
            const delayMillis = API_PROCESSED_REQUESTS_DELAY_MILLIS - (Date.now() - queueModifiedAt);
            log.info(`RequestQueue: Waiting for ${delayMillis}ms before considering the queue as finished to ensure that the data is consistent.`);
            await sleep(delayMillis);
        }

        return this._ensureHeadIsNonEmpty(ensureConsistency, nextLimit, iteration + 1);
    }

    /**
     * Adds a request straight to the queueHeadDict, to improve performance.
     * @private
     */
    _maybeAddRequestToQueueHead(requestId, forefront) {
        if (forefront) {
            this.queueHeadDict.add(requestId, requestId, true);
        } else if (this.assumedTotalCount < QUERY_HEAD_MIN_LENGTH) {
            this.queueHeadDict.add(requestId, requestId, false);
        }
    }

    /**
     * Removes the queue either from the Apify Cloud storage or from the local database,
     * depending on the mode of operation.
     *
     * @return {Promise<void>}
     */
    async drop() {
        await this.client.deleteQueue({
            queueId: this.queueId,
        });

        const idKey = createQueueCacheKey(this.queueId, this.isLocal);
        queuesCache.remove(idKey);
        if (this.queueName) {
            const nameKey = createQueueCacheKey(this.queueName);
            queuesCache.remove(nameKey);
        }
    }

    /** @ignore */
    async delete() {
        log.deprecated('requestQueue.delete() is deprecated. Please use requestQueue.drop() instead. '
            + 'This is to make it more obvious to users that the function deletes the request queue and not individual records in the queue.');
        await this.drop();
    }

    /**
     * Returns the number of handled requests.
     *
     * This function is just a convenient shortcut for:
     *
     * ```javascript
     * const { handledRequestCount } = await queue.getInfo();
     * ```
     *
     * @return {Promise<number>}
     */
    async handledCount() {
        // NOTE: We keep this function for compatibility with RequestList.handledCount()
        const { handledRequestCount } = await this.getInfo();
        return handledRequestCount;
    }

    /**
     * Returns an object containing general information about the request queue.
     *
     * The function returns the same object as the Apify API Client's
     * [getQueue](https://docs.apify.com/api/apify-client-js/latest#ApifyClient-requestQueues)
     * function, which in turn calls the
     * [Get request queue](https://apify.com/docs/api/v2#/reference/request-queues/queue/get-request-queue)
     * API endpoint.
     *
     * **Example:**
     * ```
     * {
     *   id: "WkzbQMuFYuamGv3YF",
     *   name: "my-queue",
     *   userId: "wRsJZtadYvn4mBZmm",
     *   createdAt: new Date("2015-12-12T07:34:14.202Z"),
     *   modifiedAt: new Date("2015-12-13T08:36:13.202Z"),
     *   accessedAt: new Date("2015-12-14T08:36:13.202Z"),
     *   totalRequestCount: 25,
     *   handledRequestCount: 5,
     *   pendingRequestCount: 20,
     * }
     * ```
     *
     * @returns {Promise<object>}
     */
    async getInfo() {
        return this.client.getQueue({ queueId: this.queueId });
    }
}

/**
 * Helper function that first requests queue by ID and if queue doesn't exist then gets it by name.
 *
 * @ignore
 */
const getOrCreateQueue = async (storageClient, queueIdOrName) => {
    const existingQueue = await storageClient.getQueue({ queueId: queueIdOrName });
    if (existingQueue) return existingQueue;
    return storageClient.getOrCreateQueue({ queueName: queueIdOrName });
};

/**
 * Opens a request queue and returns a promise resolving to an instance
 * of the {@link RequestQueue} class.
 *
 * {@link RequestQueue} represents a queue of URLs to crawl, which is stored either on local filesystem or in the cloud.
 * The queue is used for deep crawling of websites, where you start with several URLs and then
 * recursively follow links to other pages. The data structure supports both breadth-first
 * and depth-first crawling orders.
 *
 * For more details and code examples, see the {@link RequestQueue} class.
 *
 * @param {string} [queueIdOrName]
 *   ID or name of the request queue to be opened. If `null` or `undefined`,
 *   the function returns the default request queue associated with the actor run.
 * @param {object} [options]
 * @param {boolean} [options.forceCloud=false]
 *   If set to `true` then the function uses cloud storage usage even if the `APIFY_LOCAL_STORAGE_DIR`
 *   environment variable is set. This way it is possible to combine local and cloud storage.
 * @returns {Promise<RequestQueue>}
 * @memberof module:Apify
 * @name openRequestQueue
 * @function
 */
export const openRequestQueue = async (queueIdOrName, options = {}) => {
    const { forceCloud = false } = options;
    checkParamOrThrow(queueIdOrName, 'queueIdOrName', 'Maybe String');
    checkParamOrThrow(options, 'options', 'Object');
    checkParamOrThrow(forceCloud, 'options.forceCloud', 'Boolean');
    ensureTokenOrLocalStorageEnvExists('request queue');

    const isLocal = process.env[ENV_VARS.LOCAL_STORAGE_DIR] && !forceCloud;

    if (!queueIdOrName) {
        const defaultIdEnvVarName = ENV_VARS.DEFAULT_REQUEST_QUEUE_ID;
        queueIdOrName = process.env[defaultIdEnvVarName];
        if (!queueIdOrName && isLocal) queueIdOrName = LOCAL_ENV_VARS[defaultIdEnvVarName];
        if (!queueIdOrName) throw new Error(`The '${defaultIdEnvVarName}' environment variable is not defined.`);
    }

    const cacheKey = createQueueCacheKey(queueIdOrName, isLocal);
    let queue = queuesCache.get(cacheKey);

    if (!queue) {
        const storageClient = isLocal ? (await getApifyStorageLocal()).requestQueues : apifyClient.requestQueues;
        const queueInfo = await getOrCreateQueue(storageClient, queueIdOrName);
        queue = new RequestQueue({ ...queueInfo, storageClient });
        addQueueToCache(queue);
    }

    return queue;
};

/**
 * @param {RequestQueue} queue
 */
function addQueueToCache(queue) {
    const idKey = createQueueCacheKey(queue.queueId, queue.isLocal);
    queuesCache.add(idKey, queue);
    if (queue.queueName) {
        const nameKey = createQueueCacheKey(queue.queueName, queue.isLocal);
        queuesCache.add(nameKey, queue);
    }
}

/**
 * @param {string} identifier
 * @param {boolean} isLocal
 * @return {string}
 */
function createQueueCacheKey(identifier, isLocal) {
    return isLocal
        ? `LOCAL:${identifier}`
        : `REMOTE:${identifier}`;
}
