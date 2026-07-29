export class ControllerError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = "ControllerError";
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
  }
}

export function isControllerError(error: unknown): error is ControllerError {
  return error instanceof ControllerError;
}
