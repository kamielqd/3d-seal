// Copyright 2025 The Manifold Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
export class BundlerError extends Error {
    location;
    error;
    manifoldStack;
    constructor(failure, options) {
        super(undefined, options);
        this.cause = failure;
        this.error = failure.errors[0];
        if (this.error.location) {
            let { file, line, column } = this.error.location;
            // FIXME Given that we insert metadata into each file, we need to run this
            // through sourcemap.
            line--;
            this.manifoldStack =
                `${this.toString()}\n    at ${file}:${line}:${column}`;
        }
    }
    get name() {
        return 'BundlerError';
    }
    get message() {
        return this.error.text;
    }
}
;
export class RuntimeError extends Error {
    manifoldStack;
    cause;
    constructor(cause, message, options) {
        super(message ?? cause.message, options);
        this.cause = cause;
    }
    get name() {
        return this.cause.name;
    }
}
export class UnsupportedFormatError extends Error {
    constructor(identifier, supported) {
        const typeList = supported
            .map(entry => `\`${entry.mimetype}\` (\`.${entry.extension}\`)`)
            .reduceRight((prev, cur, index, arr) => cur +
            ((index > 0 || arr.length <= 2) ? ', or ' : ', ') + prev);
        super(`Unsupported format \`${identifier}\`.  ` +
            `Must be one of ${typeList}`);
    }
}
export class ImportError extends Error {
}
/**
 * Thrown when an HTTP fetch performed by ManifoldCAD's bundler or model/texture
 * loaders returns a non-2xx response. Carries the status and response body so
 * callers can distinguish transient (5xx, 429) from permanent (4xx) failures.
 */
export class FetchError extends Error {
    status;
    statusText;
    url;
    body;
    constructor(status, statusText, url, body) {
        super(`HTTP ${status} ${statusText} fetching ${url}` +
            (body ? `: ${body}` : ''));
        this.status = status;
        this.statusText = statusText;
        this.url = url;
        this.body = body;
    }
}
//# sourceMappingURL=error.js.map