// Puntos de enlace entre servicios que se llaman en ambas direcciones (SQS ↔ Lambda, SNS → Lambda/SQS)
// sin dependencias circulares entre módulos. Cada módulo registra aquí su función al cargarse.
import type { CloudState } from '../types';

export const bridge: {
  /** Tras enviar mensajes a una cola: Lambda puede tener que procesarlos. */
  afterSend?: (s: CloudState) => void;
  /** Se ejecuta antes de cualquier consulta para aplicar el paso del tiempo (mappings, estados de RDS...). */
  settle?: (s: CloudState) => void;
} = {};
