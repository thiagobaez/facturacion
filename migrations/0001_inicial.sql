CREATE TABLE usuarios (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
    clave_hash TEXT NOT NULL,
    nombre TEXT NOT NULL DEFAULT '',
    titulo TEXT NOT NULL DEFAULT '',
    cuit TEXT NOT NULL DEFAULT '',
    domicilio TEXT NOT NULL DEFAULT '',
    iibb TEXT NOT NULL DEFAULT '',
    inicio_actividades TEXT NOT NULL DEFAULT '',
    punto_venta INTEGER NOT NULL DEFAULT 1,
    precio_sesion TEXT NOT NULL DEFAULT '0',
    descripcion TEXT NOT NULL DEFAULT 'Sesión de psicoterapia',
    modo TEXT NOT NULL DEFAULT 'simulacion' CHECK (modo IN ('simulacion', 'homologacion', 'produccion')),
    clave_privada TEXT,
    clave_publica TEXT,
    pedido_certificado TEXT,
    certificado TEXT,
    wa_modo TEXT NOT NULL DEFAULT 'simulado' CHECK (wa_modo IN ('simulado', 'real')),
    wa_token TEXT,
    wa_numero_id TEXT NOT NULL DEFAULT '',
    wa_plantilla TEXT NOT NULL DEFAULT 'factura_sesiones',
    wa_idioma TEXT NOT NULL DEFAULT 'es_AR',
    creado TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sesiones (
    token_hash TEXT PRIMARY KEY,
    usuario_id INTEGER NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    vence INTEGER NOT NULL
);

CREATE INDEX sesiones_usuario ON sesiones (usuario_id);

CREATE TABLE intentos (
    clave TEXT NOT NULL,
    momento INTEGER NOT NULL
);

CREATE INDEX intentos_clave ON intentos (clave, momento);

CREATE TABLE tickets (
    usuario_id INTEGER NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    modo TEXT NOT NULL,
    datos TEXT NOT NULL,
    vence INTEGER NOT NULL,
    PRIMARY KEY (usuario_id, modo)
);

CREATE TABLE candados (
    usuario_id INTEGER PRIMARY KEY,
    hasta INTEGER NOT NULL
);

CREATE TABLE pacientes (
    usuario_id INTEGER NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    dni INTEGER NOT NULL,
    nombre TEXT NOT NULL,
    telefono TEXT,
    notas TEXT NOT NULL DEFAULT '',
    actualizado TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (usuario_id, dni)
);

CREATE TABLE facturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario_id INTEGER NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    lote TEXT NOT NULL,
    modo TEXT NOT NULL,
    pto_vta INTEGER NOT NULL,
    cbte_tipo INTEGER NOT NULL,
    numero INTEGER NOT NULL,
    fecha TEXT NOT NULL,
    dni INTEGER NOT NULL,
    nombre TEXT NOT NULL,
    sesiones INTEGER NOT NULL,
    precio TEXT NOT NULL,
    total TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    desde TEXT NOT NULL,
    hasta TEXT NOT NULL,
    vto_pago TEXT NOT NULL,
    cae TEXT NOT NULL,
    cae_vto TEXT NOT NULL,
    emisor TEXT NOT NULL,
    whatsapp_estado TEXT,
    whatsapp_detalle TEXT,
    whatsapp_id TEXT,
    whatsapp_fecha TEXT,
    creada TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (usuario_id, modo, pto_vta, cbte_tipo, numero)
);

CREATE INDEX facturas_usuario ON facturas (usuario_id, modo, id);
CREATE INDEX facturas_lote ON facturas (usuario_id, lote);
CREATE INDEX facturas_dni ON facturas (usuario_id, dni, desde, hasta);
