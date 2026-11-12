// Puente ligero hacia KMS para otros servicios (evita dependencias circulares).
import type { Ctx } from '../api';

export interface KmsRef {
  keyId: string;
  arn: string;
}

/** Se sustituye por la implementación real al cargar el módulo de KMS. */
export let getKmsKeyOrNull: (ctx: Ctx, idOrAlias: string) => KmsRef | null = () => null;
export function setKmsLookup(fn: typeof getKmsKeyOrNull) {
  getKmsKeyOrNull = fn;
}
