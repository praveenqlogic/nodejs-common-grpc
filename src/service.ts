/*!
 * Copyright 2015 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*!
 * @module commonGrpc/service
 */

import { Abortable, BodyResponseCallback, DecorateRequestOptions, Service, ServiceConfig, util } from '@google-cloud/common';
import { replaceProjectIdToken } from '@google-cloud/projectify';
import { loadSync, PackageDefinition, ServiceDefinition } from '@grpc/proto-loader';
import * as duplexify from 'duplexify';
import { EventEmitter } from 'events';
import * as extend from 'extend';
import * as grpc from 'grpc';
import * as is from 'is';
import * as r from 'request';
import * as retryRequest from 'retry-request';
import { Duplex } from 'stream';
import * as through from 'through2';
import { ServiceOptions } from '@google-cloud/common';
import { Compute, UserRefreshClient, JWT } from 'google-auth-library';

export interface ServiceRequestCallback {
  (err: Error | null, apiResponse?: r.Response): void;
}

export type GrpcResponse = Error & { code: number };

export interface ProtoOpts {
  service: string;
  method: string;
  timeout?: number;
  retryOpts?: retryRequest.Options;
  stream?: Duplex;
}

export interface GrpcOptions {
  deadline?: Date;
}

export interface ServiceOptionInterface extends ServiceOptions {
  maxRetries?: number;
}

export interface ServiceConfigInterface {
  grpcMetadata?: {};
  proto?: {};
  protosDir?: string;
  protoServices?: {};
  customEndpoint?: {};
  baseUrl?: string;
  scopes?: string[];
  projectIdRequired?: boolean;
  packageJson?: {};
  requestModule?: typeof r;
}

/**
 * Configuration object for GrpcService.
 */
export interface GrpcServiceConfig extends ServiceConfig {
  /** Metadata to send with every request. */
  grpcMetadata: grpc.Metadata;
  /** The root directory where proto files live. */
  protosDir: string;
  /**
   * Directly provide the required proto files. This is useful when a single
   * class requires multiple services.
   */
  protoServices: {
    [serviceName: string]: { path: string; service: string; baseUrl: string; };
  };
  customEndpoint: boolean;
}

// TODO: convert this object to an array

/**
 * @const {object} - A map of protobuf codes to HTTP status codes.
 * @private
 */
const GRPC_ERROR_CODE_TO_HTTP = {
  0: {
    code: 200,
    message: 'OK',
  },

  1: {
    code: 499,
    message: 'Client Closed Request',
  },

  2: {
    code: 500,
    message: 'Internal Server Error',
  },

  3: {
    code: 400,
    message: 'Bad Request',
  },

  4: {
    code: 504,
    message: 'Gateway Timeout',
  },

  5: {
    code: 404,
    message: 'Not Found',
  },

  6: {
    code: 409,
    message: 'Conflict',
  },

  7: {
    code: 403,
    message: 'Forbidden',
  },

  8: {
    code: 429,
    message: 'Too Many Requests',
  },

  9: {
    code: 412,
    message: 'Precondition Failed',
  },

  10: {
    code: 409,
    message: 'Conflict',
  },

  11: {
    code: 400,
    message: 'Bad Request',
  },

  12: {
    code: 501,
    message: 'Not Implemented',
  },

  13: {
    code: 500,
    message: 'Internal Server Error',
  },

  14: {
    code: 503,
    message: 'Service Unavailable',
  },

  15: {
    code: 500,
    message: 'Internal Server Error',
  },

  16: {
    code: 401,
    message: 'Unauthorized',
  },
};

/**
 * The default configuration for all gRPC Service instantions.
 *
 * @resource [All options]{@link
 * https://github.com/grpc/grpc/blob/13e185419cd177b7fb552601665e43820321a96b/include/grpc/impl/codegen/grpc_types.h#L148}
 *
 * @private
 *
 * @type {object}
 */
const GRPC_SERVICE_OPTIONS = {
  // RE: https://github.com/GoogleCloudPlatform/google-cloud-node/issues/1991
  'grpc.max_send_message_length': -1,     // unlimited
  'grpc.max_receive_message_length': -1,  // unlimited

  // RE: https://github.com/grpc/grpc/issues/8839
  // RE: https://github.com/grpc/grpc/issues/8382
  // RE: https://github.com/GoogleCloudPlatform/google-cloud-node/issues/1991
  'grpc.initial_reconnect_backoff_ms': 5000,
};

export interface ObjectToStructConverterConfig {
  removeCircular?: boolean;
  stringify?: boolean;
  maxRetries?: number;
}

export class ObjectToStructConverter {
  seenObjects: Set<{}>;
  removeCircular: boolean;
  stringify?: boolean;
  /**
   * A class that can be used to convert an object to a struct. Optionally this
   * class can be used to erase/throw on circular references during conversion.
   *
   * @private
   *
   * @param {object=} options - Configuration object.
   * @param {boolean} options.removeCircular - Remove circular references in the
   *     object with a placeholder string. (Default: `false`)
   * @param {boolean} options.stringify - Stringify un-recognized types. (Default:
   *     `false`)
   */
  constructor(options?: ObjectToStructConverterConfig) {
    options = options || {};
    this.seenObjects = new Set();
    this.removeCircular = options.removeCircular === true;
    this.stringify = options.stringify === true;
  }

  /**
   * Begin the conversion process from a JS object to an encoded gRPC Value
   * message.
   *
   * @param {*} value - The input value.
   * @return {object} - The encoded value.
   *
   * @example
   * ObjectToStructConverter.convert({
   *   aString: 'Hi'
   * });
   * // {
   * //   fields: {
   * //     aString: {
   * //       stringValue: 'Hello!'
   * //     }
   * //   }
   * // }
   */
  convert(obj: {}) {
    const convertedObject = {
      fields: {},
    };
    this.seenObjects.add(obj);
    for (const prop in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, prop)) {
        const value = (Object.getOwnPropertyDescriptor(obj, prop) as PropertyDescriptor).value; //obj[prop];
        if (is.undefined(value)) {
          continue;
        }
        const objPropertyDescriptor: PropertyDescriptor = {
          value: this.encodeValue_(value),
          configurable: true,
          enumerable: true,
          writable: true
        };
        Object.defineProperty(convertedObject.fields, prop, objPropertyDescriptor);
      }
    }
    this.seenObjects.delete(obj);
    return convertedObject;
  }

  /**
   * Convert a raw value to a type-denoted protobuf message-friendly object.
   *
   * @private
   *
   * @param {*} value - The input value.
   * @return {*} - The encoded value.
   *
   * @example
   * ObjectToStructConverter.encodeValue('Hi');
   * // {
   * //   stringValue: 'Hello!'
   * // }
   */
  encodeValue_(value: {}) {
    let convertedValue;

    if (is.null(value)) {
      convertedValue = {
        nullValue: 0,
      };
    } else if (is.number(value)) {
      convertedValue = {
        numberValue: value,
      };
    } else if (is.string(value)) {
      convertedValue = {
        stringValue: value,
      };
    } else if (is.boolean(value)) {
      convertedValue = {
        boolValue: value,
      };
    } else if (Buffer.isBuffer(value)) {
      convertedValue = {
        blobValue: value,
      };
    } else if (is.object(value)) {
      if (this.seenObjects.has(value)) {
        // Circular reference.
        if (!this.removeCircular) {
          throw new Error([
            'This object contains a circular reference. To automatically',
            'remove it, set the `removeCircular` option to true.',
          ].join(' '));
        }
        convertedValue = {
          stringValue: '[Circular]',
        };
      } else {
        convertedValue = {
          structValue: this.convert(value),
        };
      }
    } else if (is.array(value)) {
      convertedValue = {
        listValue: {
          values: (value as Array<{}>).map(this.encodeValue_.bind(this)),
        },
      };
    } else {
      if (!this.stringify) {
        throw new Error('Value of type ' + typeof value + ' not recognized.');
      }
      convertedValue = {
        stringValue: String(value),
      };
    }
    return convertedValue;
  }
}



export class GrpcService extends Service {
  grpcCredentials?: { name?: string };
  grpcMetadata?: { add: Function };
  maxRetries?: number;
  userAgent?: string;
  activeServiceMap_ = new Map();
  protos = {};

  /** A cache for proto objects. */
  private static protoObjectCache: { [name: string]: PackageDefinition } = {};

  static readonly GRPC_SERVICE_OPTIONS = GRPC_SERVICE_OPTIONS;
  static readonly GRPC_ERROR_CODE_TO_HTTP = GRPC_ERROR_CODE_TO_HTTP;
  static readonly ObjectToStructConverter = ObjectToStructConverter;

  /**
   * Service is a base class, meant to be inherited from by a "service," like
   * BigQuery or Storage.
   *
   * This handles making authenticated requests by exposing a `makeReq_`
   * function.
   *
   * @constructor
   * @alias module:common/grpc-service
   *
   * @param config - Configuration object.
   * @param {object} options - [Configuration object](#/docs/?method=gcloud).
   */
  constructor(config: ServiceConfigInterface, options: ServiceOptionInterface) {
    super(config as ServiceConfig, options);

    if (global.hasOwnProperty('GCLOUD_SANDBOX_ENV')) {
      // gRPC has a tendency to cause our doc unit tests to fail, so we prevent
      // any calls to that library from going through.
      // Reference:
      // https://github.com/GoogleCloudPlatform/google-cloud-node/pull/1137#issuecomment-193315047
      return (Object.getOwnPropertyDescriptor(global, 'GCLOUD_SANDBOX_ENV') as PropertyDescriptor).value;
    }

    if (config.customEndpoint) {
      this.grpcCredentials = grpc.credentials.createInsecure() as {};
    }

    this.grpcMetadata = new grpc.Metadata();

    this.grpcMetadata.add('x-goog-api-client', [
      'gl-node/' + process.versions.node,
      'gccl/' + (config as ServiceConfig).packageJson.version,
      'grpc/' + require('grpc/package.json').version,
    ].join(' '));

    if (config.grpcMetadata) {
      for (const prop in config.grpcMetadata) {
        if (config.grpcMetadata.hasOwnProperty(prop)) {
          this.grpcMetadata.add(prop
            , (Object.getOwnPropertyDescriptor(config.grpcMetadata, prop) as PropertyDescriptor)
              .value);
        }
      }
    }

    this.maxRetries = options.maxRetries;
    this.userAgent = util.getUserAgentFromPackageJson((config as ServiceConfig).packageJson);
    this.activeServiceMap_ = new Map();
    this.protos = {};
    const protoServices = config.protoServices as {};

    Object.keys(protoServices).forEach(name => {
      const protoConfig = (Object.getOwnPropertyDescriptor(protoServices, name) as PropertyDescriptor)
        .value;
      const services = this.loadProtoFile(protoConfig.path, config);
      const serviceKey =
        ['google', protoConfig.service, name].filter(x => x).join('.');

      const service = (Object.getOwnPropertyDescriptor(services, serviceKey) as PropertyDescriptor)
        .value as ServiceDefinition & {
          baseUrl?: string;
        };

      const objPropertyDescriptor: PropertyDescriptor = {
        value: service,
        configurable: true,
        enumerable: true,
        writable: true
      };
      Object.defineProperty(this.protos, name, objPropertyDescriptor);

      if (protoConfig.baseUrl) {
        service.baseUrl = protoConfig.baseUrl;
      }
    });
  }


  /**
   * Make an authenticated request with gRPC.
   *
   * @param {object} protoOpts - The proto options.
   * @param {string} protoOpts.service - The service name.
   * @param {string} protoOpts.method - The method name.
   * @param {number=} protoOpts.timeout - After how many milliseconds should the
   *     request cancel.
   * @param {object} reqOpts - The request options.
   * @param {function=} callback - The callback function.
   */
  request(
    protoOpts?: {}, reqOpts?: {},
    callback?: {}): Abortable | void | Promise<r.Response>;
  request(reqOpts: DecorateRequestOptions): Promise<r.Response>;
  request(reqOpts: DecorateRequestOptions, callback: BodyResponseCallback):
    void;
  request(reqOpts: DecorateRequestOptions, callback?: BodyResponseCallback):
    void | Promise<r.Response>;
  request(
    protoOpts: ProtoOpts, reqOpts: DecorateRequestOptions,
    callback: ServiceRequestCallback): Abortable | void;
  request(
    pOpts: ProtoOpts | DecorateRequestOptions,
    rOpts?: DecorateRequestOptions | BodyResponseCallback,
    callback?: ServiceRequestCallback): Abortable | void | Promise<r.Response> {
    /**
     * The function signature above is a little funky.  This is due to the way
     * method overloading in TypeScript operates.  Since this class extends
     * Service, the signatures for `request` need to have
     * *something* in common.  The only signature actually used here is:
     *
     * request(protoOpts: ProtoOpts, reqOpts: DecorateRequestOptions, callback:
     * ServiceRequestCallback): Abortable|void;
     *
     * Hence the weird casting below.
     */
    const protoOpts = pOpts as ProtoOpts;
    let reqOpts = rOpts as DecorateRequestOptions;

    if (global.hasOwnProperty('GCLOUD_SANDBOX_ENV')) {
      return (Object.getOwnPropertyDescriptor(global, 'GCLOUD_SANDBOX_ENV') as PropertyDescriptor)
        .value;
    }

    if (!this.grpcCredentials) {
      // We must establish an authClient to give to grpc.
      this.getGrpcCredentials_((err: Error, credentials: {}) => {
        if (err) {
          callback!(err);
          return;
        }

        this.grpcCredentials = credentials;
        this.request(protoOpts, reqOpts, callback!);
      });

      return;
    }

    const service = this.getService_(protoOpts);
    const metadata = this.grpcMetadata;
    const grpcOpts: GrpcOptions = {};

    if (typeof protoOpts.timeout === 'number') {
      grpcOpts.deadline = GrpcService.createDeadline_(protoOpts.timeout);
    }

    try {
      reqOpts = this.decorateRequest_(reqOpts) as DecorateRequestOptions;
    } catch (e) {
      callback!(e);
      return;
    }

    // Retains a reference to an error from the response. If the final callback
    // is executed with this as the "response", we return it to the user as an
    // error.
    let respError: Error | null;

    const retryOpts = Object.assign(
      {
        retries: this.maxRetries,
        currentRetryAttempt: 0,
        shouldRetryFn: GrpcService.shouldRetryRequest_,

        // retry-request determines if it should retry from the incoming HTTP
        // response status. gRPC always returns an error proto message. We
        // pass that "error" into retry-request to act as the HTTP response,
        // so it can use the status code to determine if it should retry.
        request(_: {}, onResponse: Function) {
          respError = null;

          return (Object.getOwnPropertyDescriptor(service, protoOpts.method) as PropertyDescriptor)
            .value(
              reqOpts, metadata, grpcOpts, (err: GrpcResponse, resp: {}) => {
                if (err) {
                  respError = GrpcService.decorateError_(err) as Error;

                  if (respError) {
                    onResponse(null, respError);
                    return;
                  }
                  onResponse(err, resp);
                  return;
                }

                onResponse(null, resp);
              });
        },
      },
      protoOpts.retryOpts);

    return retryRequest(null!, retryOpts, (err: Error, resp: {}) => {
      if (!err && resp === respError) {
        err = respError;
        resp = null!;
      }
      callback!(err, resp as r.Response);
    });
  }

  /**
   * Make an authenticated streaming request with gRPC.
   *
   * @param {object} protoOpts - The proto options.
   * @param {string} protoOpts.service - The service.
   * @param {string} protoOpts.method - The method name.
   * @param {number=} protoOpts.timeout - After how many milliseconds should the
   *     request cancel.
   * @param {object} reqOpts - The request options.
   */
  requestStream(protoOpts?: {}, reqOpts?: {}, callback?: Function): r.Request;
  requestStream(reqOpts: DecorateRequestOptions): r.Request;
  requestStream(protoOpts: ProtoOpts, reqOpts: DecorateRequestOptions): Duplex;
  requestStream(
    pOpts: ProtoOpts | DecorateRequestOptions,
    rOpts?: DecorateRequestOptions): Duplex | r.Request {
    /**
     * The function signature above is a little funky.  This is due to the way
     * method overloading in TypeScript operates.  Since this class extends
     * Service, the signatures for `requestStream` need to have
     * *something* in common.  The only signature actually used here is:
     *
     * requestStream(protoOpts: ProtoOpts, reqOpts: DecorateRequestOptions):
     * Duplex;
     *
     * Hence the weird casting below.
     */
    if (global.hasOwnProperty('GCLOUD_SANDBOX_ENV')) {
      return through.obj();
    }
    const protoOpts = pOpts as ProtoOpts;
    let reqOpts = rOpts as DecorateRequestOptions;

    if (!protoOpts.stream) {
      protoOpts.stream = through.obj();
    }

    const stream = protoOpts.stream;

    if (!this.grpcCredentials) {
      // We must establish an authClient to give to grpc.
      this.getGrpcCredentials_((err: Error, credentials: {}) => {
        if (err) {
          stream.destroy(err);
          return;
        }
        this.grpcCredentials = credentials;
        this.requestStream(protoOpts, reqOpts);
      });
      return stream;
    }

    const objectMode = !!reqOpts.objectMode;
    const service = this.getService_(protoOpts);
    const grpcMetadata = this.grpcMetadata;
    const grpcOpts: GrpcOptions = {};

    if (typeof protoOpts.timeout === 'number') {
      grpcOpts.deadline = GrpcService.createDeadline_(protoOpts.timeout);
    }

    try {
      reqOpts = this.decorateRequest_(reqOpts) as DecorateRequestOptions;
    } catch (e) {
      setImmediate(() => {
        stream.destroy(e);
      });
      return stream;
    }

    const a = Object.getPrototypeOf(service);

    const retryOpts = Object.assign(
      {
        retries: this.maxRetries,
        currentRetryAttempt: 0,
        objectMode,
        shouldRetryFn: GrpcService.shouldRetryRequest_,
        request() {
          const ee: EventEmitter =
            (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), protoOpts.method) as PropertyDescriptor)
              .value(reqOpts, grpcMetadata, grpcOpts)
              .on('metadata', () => {
                // retry-request requires a server response before it
                // starts emitting data. The closest mechanism grpc
                // provides is a metadata event, but this does not provide
                // any kind of response status. So we're faking it here
                // with code `0` which translates to HTTP 200.
                //
                // https://github.com/GoogleCloudPlatform/google-cloud-node/pull/1444#discussion_r71812636
                const grcpStatus = GrpcService.decorateStatus_({ code: 0 } as GrpcResponse);
                ee.emit('response', grcpStatus);
              });
          return ee;
        },
      },
      protoOpts.retryOpts);



    // tslint:disable-next-line:no-any
    return (retryRequest(null!, retryOpts) as any)
      .on('error',
        (err: GrpcResponse) => {
          const grpcError = GrpcService.decorateError_(err) as Error;
          stream.destroy(grpcError || err);
        })
      .on('request', stream.emit.bind(stream, 'request'))
      .pipe(stream);
  }

  /**
   * Make an authenticated writable streaming request with gRPC.
   *
   * @param {object} protoOpts - The proto options.
   * @param {string} protoOpts.service - The service.
   * @param {string} protoOpts.method - The method name.
   * @param {number=} protoOpts.timeout - After how many milliseconds should the
   *     request cancel.
   * @param {object} reqOpts - The request options.
   */
  requestWritableStream(protoOpts: {}, reqOpts?: {}): r.Request;
  requestWritableStream(protoOpts: ProtoOpts, reqOpts: DecorateRequestOptions) {
    const stream =
      // tslint:disable-next-line:no-any
      (protoOpts.stream = protoOpts.stream || (duplexify as { obj: Function }).obj());

    if (global.hasOwnProperty('GCLOUD_SANDBOX_ENV')) {
      return stream;
    }

    const self = this;

    if (!this.grpcCredentials) {
      // We must establish an authClient to give to grpc.
      this.getGrpcCredentials_((err: Error, credentials: {}) => {
        if (err) {
          stream.destroy(err);
          return;
        }

        self.grpcCredentials = credentials;
        self.requestWritableStream(protoOpts, reqOpts);
      });

      return stream;
    }

    const service = this.getService_(protoOpts);
    const grpcMetadata = this.grpcMetadata;
    const grpcOpts: GrpcOptions = {};

    if (protoOpts.timeout && is.number(protoOpts.timeout)) {
      grpcOpts.deadline = GrpcService.createDeadline_(protoOpts.timeout);
    }

    try {
      reqOpts = this.decorateRequest_(reqOpts) as DecorateRequestOptions;
    } catch (e) {
      setImmediate(() => {
        stream.destroy(e);
      });
      return stream;
    }

    const grpcStream =
      (Object.getOwnPropertyDescriptor(Object.getPrototypeOf(service), protoOpts.method) as PropertyDescriptor)
        .value(reqOpts, grpcMetadata, grpcOpts)
        .on('status',
          (status: GrpcResponse) => {
            const grcpStatus = GrpcService.decorateStatus_(status);
            stream.emit('response', grcpStatus || status);
          })
        .on('error', (err: GrpcResponse) => {
          const grpcError = GrpcService.decorateError_(err);
          stream.destroy(grpcError || err);
        });

    stream.setReadable(grpcStream);
    stream.setWritable(grpcStream);

    return stream;
  }

  /**
   * Decode a protobuf Struct's value.
   *
   * @param {object} value - A Struct's Field message.
   * @return {*} - The decoded value.
   */
  static decodeValue_(value: { kind?: string, structValue?: { fields?: {} }, listValue?: { values: {}[] } }): {} | null {
    switch (value.kind) {
      case 'structValue': {
        if (value.structValue) {
          return GrpcService.structToObj_(value.structValue);
        }
        else {
          return null;
        }
      }

      case 'nullValue': {
        return null;
      }

      case 'listValue': {
        if (value.listValue) {
          return value.listValue.values.map(GrpcService.decodeValue_);
        }
        else {
          return null;
        }
      }

      default: {
        if (value.kind) {
          return (Object.getOwnPropertyDescriptor(value, value.kind) as PropertyDescriptor).value;
        }
        else {
          return null;
        }
      }
    }
  }

  /**
   * Convert a raw value to a type-denoted protobuf message-friendly object.
   *
   *
   * @param {*} value - The input value.
   * @return {*} - The encoded value.
   *
   * @example
   * ObjectToStructConverter.encodeValue('Hi');
   * // {
   * //   stringValue: 'Hello!'
   * // }
   */
  static encodeValue_(value: {}) {
    return new GrpcService.ObjectToStructConverter().encodeValue_(value);
  }

  /**
   * Creates a deadline.
   *
   * @private
   *
   * @param {number} timeout - Timeout in miliseconds.
   * @return {date} deadline - The deadline in Date object form.
   */
  static createDeadline_(timeout: number) {
    return new Date(Date.now() + timeout);
  }

  /**
   * Checks for a grpc status code and extends the error object with additional
   * information.
   *
   * @private
   *
   * @param {error|object} err - The grpc error.
   * @return {error|null}
   */
  static decorateError_(err: GrpcResponse | {}): Error | null | {} {
    const errorObj = is.error(err) ? err : {};
    return GrpcService.decorateGrpcResponse_(errorObj, err as GrpcResponse);
  }

  /**
   * Checks for a grpc status code and extends the supplied object with
   * additional information.
   *
   * @private
   *
   * @param {object} obj - The object to be extended.
   * @param {object} response - The grpc response.
   * @return {object|null}
   */
  static decorateGrpcResponse_(obj: {}, response: GrpcResponse): Error | null | {} {

    if (response && GRPC_ERROR_CODE_TO_HTTP.hasOwnProperty(response.code)) {
      const defaultResponseDetails = (Object
        .getOwnPropertyDescriptor(GRPC_ERROR_CODE_TO_HTTP, response.code) as PropertyDescriptor)
        .value;

      let message = defaultResponseDetails.message;

      if (response.message) {
        // gRPC error messages can be either stringified JSON or strings.
        try {
          message = JSON.parse(response.message).description;
        } catch (e) {
          message = response.message;
        }
      }

      return extend(true, obj, response, {
        code: defaultResponseDetails.code,
        message,
      });
    }

    return null;
  }

  /**
   * Checks for grpc status code and extends the status object with additional
   * information
   *
   * @private
   * @param {object} status - The grpc status.
   * @return {object|null}
   */
  static decorateStatus_(status: GrpcResponse) {
    return GrpcService.decorateGrpcResponse_({}, status);
  }

  /**
   * Function to decide whether or not a request retry could occur.
   *
   * @private
   *
   * @param {object} response - The request response.
   * @return {boolean} shouldRetry
   */
  static shouldRetryRequest_(response: GrpcResponse) {
    return [429, 500, 502, 503].indexOf(response.code) > -1;
  }

  /**
   * Convert an object to a struct.
   *
   * @private
   *
   * @param {object} obj - An object to convert.
   * @param {object=} options - Configuration object.
   * @param {boolean} options.removeCircular - Remove circular references in the
   *     object with a placeholder string.
   * @param {boolean} options.stringify - Stringify un-recognized types.
   * @return {array} - The converted object.
   *
   * @example
   * GrpcService.objToStruct_({
   *   greeting: 'Hello!',
   *   favNumber: 7,
   *   friendIds: [
   *     1004,
   *     1006
   *   ],
   *   userDetails: {
   *     termsSigned: true
   *   }
   * });
   * // {
   * //   fields: {
   * //     greeting: {
   * //       stringValue: 'Hello!'
   * //     },
   * //     favNumber: {
   * //       numberValue: 7
   * //     },
   * //     friendIds: {
   * //       listValue: [
   * //         {
   * //           numberValue: 1004
   * //         },
   * //         {
   * //           numberValue: 1006
   * //         }
   * //       ]
   * //     },
   * //     userDetails: {
   * //       fields: {
   * //         termsSigned: {
   * //           booleanValue: true
   * //         }
   * //       }
   * //     }
   * //   }
   * // }
   */
  static objToStruct_(obj: {}, options: ObjectToStructConverterConfig) {
    return new GrpcService.ObjectToStructConverter(options).convert(obj);
  }

  /**
   * Condense a protobuf Struct into an object of only its values.
   *
   * @private
   *
   * @param {object} struct - A protobuf Struct message.
   * @return {object} - The simplified object.
   *
   * @example
   * GrpcService.structToObj_({
   *   fields: {
   *     name: {
   *       kind: 'stringValue',
   *       stringValue: 'Stephen'
   *     }
   *   }
   * });
   * // {
   * //   name: 'Stephen'
   * // }
   */
  static structToObj_(struct: { fields?: {} }) {
    const convertedObject = {};

    if (struct.fields) {
      for (const prop in struct.fields) {
        if (struct.fields.hasOwnProperty(prop)) {
          const value = (Object.getOwnPropertyDescriptor(struct.fields, prop) as PropertyDescriptor).value;
          const decodeValue: PropertyDescriptor = {
            value: GrpcService.decodeValue_(value),
            configurable: true,
            enumerable: true,
            writable: true
          };
          Object.defineProperty(convertedObject, prop, decodeValue);
        }
      }
    }

    return convertedObject;
  }

  /**
   * Assign a projectId if one is specified to all request options.
   *
   * @param {object} reqOpts - The request options.
   * @return {object} - The decorated request object.
   */
  decorateRequest_(reqOpts: {}): DecorateRequestOptions | {};
  decorateRequest_(reqOpts: DecorateRequestOptions) {
    reqOpts = Object.assign({}, reqOpts);

    delete reqOpts.autoPaginate;
    delete reqOpts.autoPaginateVal;
    delete reqOpts.objectMode;

    return replaceProjectIdToken(reqOpts, this.projectId);
  }


  /**
   * To authorize requests through gRPC, we must get the raw google-auth-library
   * auth client object.
   *
   * @private
   *
   * @param {function} callback - The callback function.
   * @param {?error} callback.err - An error getting an auth client.
   */
  getGrpcCredentials_(callback: Function) {
    this.authClient.getClient().then((client: Compute | UserRefreshClient | JWT) => {
      const credentials = grpc.credentials.combineChannelCredentials(
        grpc.credentials.createSsl(),
        grpc.credentials.createFromGoogleCredential(client));
      if (!this.projectId || this.projectId === '{{projectId}}') {
        this.projectId = client.projectId!;
      }
      callback(null, credentials);
    }, callback as (reason: {}) => {});
  }

  /**
   * Loads a proto file, useful when handling multiple proto files/services
   * within a single instance of GrpcService.
   *
   * @private
   *
   * @param protoConfig - The proto specific configs for this file.
   * @param config - The base config for the GrpcService.
   * @return protoObject - The loaded proto object.
   */
  loadProtoFile(protoPath: {}, config: {}): {}
  loadProtoFile(protoPath: string, config: GrpcServiceConfig):
    PackageDefinition {
    const protoObjectCacheKey = [config.protosDir, protoPath].join('$');

    if (!GrpcService.protoObjectCache[protoObjectCacheKey]) {
      const services = loadSync(protoPath, {
        keepCase: false,
        defaults: true,
        bytes: String,
        longs: String,
        enums: String,
        oneofs: true,
        includeDirs: [config.protosDir]
      });
      GrpcService.protoObjectCache[protoObjectCacheKey] = services;
    }

    return GrpcService.protoObjectCache[protoObjectCacheKey];
  }

  /**
   * Retrieves the service object used to make the grpc requests.
   *
   * @private
   *
   * @param {object} protoOpts - The proto options.
   * @return {object} service - The proto service.
   */
  getService_(protoOpts: {}): {}
  getService_(protoOpts: ProtoOpts) {
    let proto = (Object.getOwnPropertyDescriptor(this.protos, protoOpts.service) as PropertyDescriptor).value;
    if (protoOpts.hasOwnProperty(protoOpts.service)) {
      proto = (Object.getOwnPropertyDescriptor(protoOpts, protoOpts.service) as
        PropertyDescriptor)
        .value;
    }
    let service = this.activeServiceMap_.get(protoOpts.service);

    if (!service) {
      const serviceInstance = (Object.getOwnPropertyDescriptor(proto, protoOpts.service) as PropertyDescriptor).value;
      service = new serviceInstance(
        proto.baseUrl || this.baseUrl, this.grpcCredentials,
        Object.assign(
          {
            'grpc.primary_user_agent': this.userAgent,
          },
          GRPC_SERVICE_OPTIONS));

      this.activeServiceMap_.set(protoOpts.service, service);
    }

    return service;
  }
}
