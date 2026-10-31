// The kernel's closed set of failures lives in @browserkit/protocol (errors.ts), shared with
// crawl, mapped sites and abilities. These names keep the engine's callers unchanged.
import {
  ERRORS,
  ERROR_CODES,
  describeError,
  errorHint,
  isErrorCode,
  type ErrorCode,
} from "@browserkit/protocol";

export type KernelErrorCode = ErrorCode;

/** Each code's recovery hint, for help('errors'). */
export const KERNEL_ERRORS = Object.fromEntries(
  ERROR_CODES.map((code) => [code, errorHint(code)]),
) as Record<ErrorCode, string>;

export const KERNEL_ERROR_CODES = ERROR_CODES;

export const isKernelErrorCode = isErrorCode;

export const describeKernelError = describeError;

export { ERRORS };
