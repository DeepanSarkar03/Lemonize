export type ScannerErrorKind = 'rejected' | 'operational' | 'authentication' | 'bad_request';

/** Safe, enumerable-by-code scanner error. Arbitrary upstream messages are never retained. */
export class ScannerError extends Error {
  readonly kind: ScannerErrorKind;
  readonly code: string;
  readonly httpStatus: number;

  constructor(kind: ScannerErrorKind, code: string, httpStatus: number) {
    super(code);
    this.name = 'ScannerError';
    this.kind = kind;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
