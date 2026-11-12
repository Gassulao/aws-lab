// Errores con la forma de los de AWS. El CLI los muestra como:
//   An error occurred (Code) when calling the Operation operation: Mensaje

export class AwsError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'AwsError';
  }
}

export function cliErrorText(e: AwsError, operation: string): string {
  return `An error occurred (${e.code}) when calling the ${operation} operation: ${e.message}`;
}

export function isAwsError(e: unknown): e is AwsError {
  return e instanceof AwsError;
}
