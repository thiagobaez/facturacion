-- Comprobantes pedidos a ARCA cuya respuesta todavía no se confirmó. Si el Worker se corta entre
-- el pedido del CAE y el guardado, la próxima tanda consulta a ARCA y los completa o los descarta.
CREATE TABLE pendientes (
    usuario_id INTEGER NOT NULL REFERENCES usuarios (id) ON DELETE CASCADE,
    modo TEXT NOT NULL,
    pto_vta INTEGER NOT NULL,
    cbte_tipo INTEGER NOT NULL,
    numero INTEGER NOT NULL,
    datos TEXT NOT NULL,
    creado TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (usuario_id, modo, pto_vta, cbte_tipo, numero)
);
