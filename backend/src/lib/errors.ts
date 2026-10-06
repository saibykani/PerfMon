// Standard API error envelope:
// { timestamp, status, error, message, path, details? }
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new ApiError(400, 'VALIDATION_ERROR', message, details);
export const unauthorized = (message = 'Authentication required') => new ApiError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have permission to perform this action') => new ApiError(403, 'FORBIDDEN', message);
export const notFound = (what: string, id?: string) => new ApiError(404, 'NOT_FOUND', id ? `${what} '${id}' not found` : `${what} not found`);
export const conflict = (message: string, details?: unknown) => new ApiError(409, 'CONFLICT', message, details);
export const tooLarge = (message: string) => new ApiError(413, 'PAYLOAD_TOO_LARGE', message);
export const unprocessable = (message: string, details?: unknown) => new ApiError(422, 'UNPROCESSABLE', message, details);

export function errorBody(status: number, code: string, message: string, path: string, details?: unknown) {
  return { timestamp: new Date().toISOString(), status, error: code, message, path, ...(details !== undefined ? { details } : {}) };
}
