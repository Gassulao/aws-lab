// Utilidades para preparar escenarios de laboratorio (recursos previos, entornos rotos).
import { runString, type Shell } from '../../shell';

/** Ejecuta líneas de shell sin anotarlas en el registro de comandos y lanza un error si alguna falla. */
export async function prep(sh: Shell, lines: string[]): Promise<void> {
  for (const line of lines) {
    const r = await runString(sh, line);
    if (r.code !== 0) throw new Error(`No se pudo preparar el escenario: «${line}» → ${(r.err || r.out).trim()}`);
  }
}

/** Configura un perfil de AWS CLI con las credenciales de un usuario IAM recién creado. */
export const profileFor = (user: string): string[] => [
  `K_${user.replace(/\W/g, '_')}=$(aws iam create-access-key --user-name ${user} --query AccessKey --output json)`,
  `aws configure set aws_access_key_id $(echo $K_${user.replace(/\W/g, '_')} | jq -r .AccessKeyId) --profile ${user}`,
  `aws configure set aws_secret_access_key $(echo $K_${user.replace(/\W/g, '_')} | jq -r .SecretAccessKey) --profile ${user}`,
  `aws configure set region eu-west-1 --profile ${user}`,
];
