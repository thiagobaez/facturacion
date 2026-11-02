export interface Env {
  DB: D1Database
  ARCHIVOS: R2Bucket
  ASSETS: Fetcher
  SECRETO_DATOS: string
  SECRETO_DATOS_ANTERIOR?: string
  COOKIE_SEGURA?: string
  SIMULAR_ARCA?: string
}

export type Modo = "simulacion" | "homologacion" | "produccion"
export type ModoWhatsApp = "simulado" | "real"

export interface Usuario {
  id: number
  usuario: string
  clave_hash: string
  nombre: string
  titulo: string
  cuit: string
  domicilio: string
  iibb: string
  inicio_actividades: string
  punto_venta: number
  precio_sesion: string
  descripcion: string
  modo: Modo
  clave_privada: string | null
  clave_publica: string | null
  pedido_certificado: string | null
  certificado: string | null
  wa_modo: ModoWhatsApp
  wa_token: string | null
  wa_numero_id: string
  wa_plantilla: string
  wa_idioma: string
  mensaje_whatsapp: string
}

export interface Emisor {
  nombre: string
  titulo: string
  cuit: string
  domicilio: string
  iibb: string
  inicio_actividades: string
}

export interface Factura {
  id: number
  usuario_id: number
  lote: string
  modo: Modo
  pto_vta: number
  cbte_tipo: number
  numero: number
  fecha: string
  dni: number
  nombre: string
  sesiones: number
  precio: string
  total: string
  descripcion: string
  desde: string
  hasta: string
  vto_pago: string
  cae: string
  cae_vto: string
  emisor: string
  obra_social: string
  plan: string
  numero_socio: string
  whatsapp_estado: string | null
  whatsapp_detalle: string | null
  whatsapp_id: string | null
  whatsapp_fecha: string | null
  enlace_version: number
}

export interface Paciente {
  dni: number
  nombre: string
  telefono: string | null
  notas: string
  obra_social: string
  plan: string
  numero_socio: string
}
