import { Hono, type Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { zipSync } from "fflate"
import * as auth from "./auth"
import { cifrar, secretos } from "./cifrado"
import * as datos from "./datos"
import {
  ErrorUsuario,
  marcarWhatsApp,
  facturarLote,
  faltantes,
  modoDe,
  pdfDe,
  simulado,
  type Dependencias,
} from "./facturador"
import { nombreArchivo } from "./pdf"
import type { Env, Factura, Usuario } from "./tipos"
import * as validar from "./validacion"
import { MENSAJE_PREDETERMINADO, mostrarTelefono } from "./whatsapp"
import { enlacePublico, enlaceValido, leerEnlace } from "./enlaces"
import { certificadoDesdeArchivo, generarClaveYPedido, leerCertificado } from "./arca/certificado"

export const NOMBRE_APP = "Facturación"

type Variables = { usuario: Usuario; token: string }
type Ctx = Context<{ Bindings: Env; Variables: Variables }>

// Las mismas cabeceras (salvo Cache-Control) están en public/_headers para las pantallas estáticas.
const CABECERAS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-store",
}

function mismoOrigen(origen: string, url: string): boolean {
  try {
    return new URL(origen).host === new URL(url).host
  } catch {
    return false
  }
}

function cookieSegura(c: Ctx): boolean {
  return c.env.COOKIE_SEGURA !== "false"
}

// En producción las cookies llevan el prefijo __Host-: el navegador las rechaza si no son Secure,
// si tienen Domain o si no son de toda la app. En local (sin HTTPS) van sin prefijo.
function prefijo(c: Ctx) {
  return cookieSegura(c) ? ("host" as const) : undefined
}

function leerCookie(c: Ctx, nombre: string) {
  return getCookie(c, nombre, prefijo(c))
}

function ponerCookie(c: Ctx, nombre: string, valor: string, segundos: number) {
  setCookie(c, nombre, valor, {
    httpOnly: true,
    secure: cookieSegura(c),
    sameSite: "Strict",
    path: "/",
    maxAge: segundos,
    prefix: prefijo(c),
  })
}

function ipDe(c: Ctx) {
  return c.req.header("CF-Connecting-IP") ?? "local"
}

function vistaPaciente(p: { dni: number; nombre: string; telefono: string | null; notas: string }) {
  return { ...p, telefono_visible: p.telefono ? mostrarTelefono(p.telefono) : null }
}

function vistaCuenta(env: Env, u: Usuario) {
  let certificado = null
  if (u.certificado && u.clave_publica) {
    try {
      certificado = leerCertificado(u.certificado, u.clave_publica)
    } catch {}
  }
  return {
    usuario: u.usuario,
    nombre: u.nombre,
    titulo: u.titulo,
    cuit: u.cuit,
    domicilio: u.domicilio,
    iibb: u.iibb,
    inicio_actividades: u.inicio_actividades,
    punto_venta: u.punto_venta,
    descripcion: u.descripcion,
    simulacion: simulado(env),
    arca: { tiene_pedido: !!u.pedido_certificado, certificado },
    mensaje_whatsapp: u.mensaje_whatsapp || MENSAJE_PREDETERMINADO,
    faltantes: faltantes(u, env),
  }
}

export function crearApp(dep: (env: Env) => Dependencias = () => ({})) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>()

  app.onError((err, c) => {
    if (err instanceof validar.Invalido || err instanceof ErrorUsuario) return c.json({ detail: err.message }, 422)
    console.error(err)
    return c.json({ detail: "Algo salió mal. Probá de nuevo en un rato." }, 500)
  })

  app.use("*", async (c, siguiente) => {
    const origen = c.req.header("Origin")
    if (!["GET", "HEAD"].includes(c.req.method) && origen && !mismoOrigen(origen, c.req.url)) {
      c.res = c.json({ detail: "Origen no permitido" }, 403)
    } else {
      await siguiente()
    }
    for (const [nombre, valor] of Object.entries(CABECERAS)) c.res.headers.set(nombre, valor)
  })

  app.post("/api/login", async (c) => {
    const cuerpo = await c.req.json().catch(() => ({}))
    const usuario = typeof cuerpo.usuario === "string" ? cuerpo.usuario.slice(0, 80) : ""
    const clave = typeof cuerpo.clave === "string" ? cuerpo.clave.slice(0, 200) : ""
    if (!usuario || !clave) return c.json({ detail: "Completá usuario y contraseña." }, 422)
    const conocido = await auth.esDispositivoConocido(secretos(c.env), usuario, leerCookie(c, auth.COOKIE_DISPOSITIVO))
    const limites = auth.limitesLogin(usuario, ipDe(c), conocido)
    if (!(await auth.registrarIntento(c.env.DB, limites))) {
      return c.json({ detail: "Demasiados intentos. Esperá unos minutos y probá de nuevo." }, 429)
    }
    const encontrado = await auth.buscarParaLogin(c.env.DB, usuario, clave)
    if (!encontrado) return c.json({ detail: "El usuario o la contraseña no son correctos." }, 401)
    await auth.limpiarIntentos(c.env.DB, [limites[0].clave])
    ponerCookie(c, auth.COOKIE, await auth.crearSesion(c.env.DB, encontrado.id), auth.DURACION_SESION)
    ponerCookie(c, auth.COOKIE_DISPOSITIVO, await auth.marcaDispositivo(c.env.SECRETO_DATOS, usuario), auth.DURACION_DISPOSITIVO)
    return c.json({ ok: true })
  })

  app.post("/api/logout", async (c) => {
    await auth.cerrarSesion(c.env.DB, leerCookie(c, auth.COOKIE))
    deleteCookie(c, auth.COOKIE, { path: "/", secure: cookieSegura(c), prefix: prefijo(c) })
    return c.json({ ok: true })
  })

  app.get("/f/:clave", async (c) => {
    const enlace = leerEnlace(c.req.param("clave").replace(/\.pdf$/, ""))
    const f = enlace ? await c.env.DB.prepare("SELECT * FROM facturas WHERE id = ?").bind(enlace.id).first<Factura>() : null
    if (!enlace || !f || !(await enlaceValido(secretos(c.env), f, enlace))) {
      return c.text("Este enlace no es válido o ya venció. Pedile a quien te lo mandó uno nuevo.", 404)
    }
    return new Response(await pdfDe(c.env, f), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${nombreArchivo(f)}"`,
        "X-Robots-Tag": "noindex, nofollow",
        "Cache-Control": "private, no-store",
      },
    })
  })

  app.use("*", async (c, siguiente) => {
    const token = leerCookie(c, auth.COOKIE)
    const usuario = await auth.usuarioDeSesion(c.env.DB, token)
    if (!usuario) {
      if (c.req.path.startsWith("/api/")) return c.json({ detail: "Tenés que iniciar sesión" }, 401)
      return c.redirect("/login", 303)
    }
    c.set("usuario", usuario)
    c.set("token", token!)
    await siguiente()
  })

  app.get("/api/cuenta", (c) => c.json({ ...vistaCuenta(c.env, c.get("usuario")), app: NOMBRE_APP }))

  app.put("/api/cuenta", async (c) => {
    const u = c.get("usuario")
    const cuerpo = await c.req.json().catch(() => null)
    const d = validar.datosCuenta(cuerpo)
    const cambiaCuit = d.cuit !== u.cuit
    if (cambiaCuit && (u.certificado || u.pedido_certificado) && cuerpo?.quitar_certificado !== true) {
      return c.json(
        {
          detail:
            "El certificado de ARCA que cargaste es del CUIT anterior. Si cambiás el CUIT se va a quitar el certificado " +
            "y vas a tener que generar uno nuevo para el CUIT nuevo.",
          confirmar: "quitar_certificado",
        },
        409,
      )
    }
    // Si el CUIT cambia, el certificado, la clave y el pedido se borran en la misma sentencia:
    // nunca puede quedar un certificado de un CUIT cargado en una cuenta con otro.
    const fila = await c.env.DB.prepare(
      "UPDATE usuarios SET " +
        "certificado = CASE WHEN cuit = ?1 THEN certificado END, clave_privada = CASE WHEN cuit = ?1 THEN clave_privada END, " +
        "clave_publica = CASE WHEN cuit = ?1 THEN clave_publica END, pedido_certificado = CASE WHEN cuit = ?1 THEN pedido_certificado END, " +
        "nombre = ?2, titulo = ?3, cuit = ?1, domicilio = ?4, iibb = ?5, inicio_actividades = ?6, " +
        "punto_venta = ?7, descripcion = ?8 WHERE id = ?9 RETURNING *",
    )
      .bind(d.cuit, d.nombre, d.titulo, d.domicilio, d.iibb, d.inicio_actividades, d.punto_venta, d.descripcion, u.id)
      .first<Usuario>()
    if (cambiaCuit) await c.env.DB.prepare("DELETE FROM tickets WHERE usuario_id = ?").bind(u.id).run()
    return c.json(vistaCuenta(c.env, fila!))
  })

  app.post("/api/cuenta/pedido", async (c) => {
    const u = c.get("usuario")
    const { forzar } = await c.req.json().catch(() => ({}))
    if (!validar.cuitValido(u.cuit) || !u.nombre.trim()) throw new validar.Invalido("Primero guardá tu nombre y tu CUIT.")
    if (u.pedido_certificado && !forzar) return c.json({ pedido: u.pedido_certificado, nuevo: false })
    if (u.certificado && !forzar) throw new validar.Invalido("Ya tenés un certificado cargado.")
    const generado = await generarClaveYPedido(u.nombre, u.cuit)
    await c.env.DB.prepare(
      "UPDATE usuarios SET clave_privada = ?, clave_publica = ?, pedido_certificado = ?, certificado = NULL WHERE id = ?",
    )
      .bind(await cifrar(c.env.SECRETO_DATOS, generado.clavePrivada), generado.clavePublica, generado.pedido, u.id)
      .run()
    await c.env.DB.prepare("DELETE FROM tickets WHERE usuario_id = ?").bind(u.id).run()
    return c.json({ pedido: generado.pedido, nuevo: true })
  })

  app.post("/api/cuenta/certificado", async (c) => {
    const u = c.get("usuario")
    const { archivo } = await c.req.json().catch(() => ({}))
    if (typeof archivo !== "string" || !archivo || archivo.length > 40_000) throw new validar.Invalido("Elegí el archivo .crt")
    if (!u.clave_publica) throw new validar.Invalido("Primero generá el pedido de certificado.")
    let pem: string
    try {
      pem = certificadoDesdeArchivo(archivo)
    } catch {
      throw new validar.Invalido("No se pudo leer el archivo.")
    }
    let info
    try {
      info = leerCertificado(pem, u.clave_publica)
    } catch (e) {
      throw new validar.Invalido(e instanceof Error ? e.message : "Certificado inválido")
    }
    if (!info.cuit) throw new validar.Invalido("El certificado no indica a qué CUIT pertenece. Tiene que ser el .crt que descargaste de ARCA.")
    if (info.cuit !== u.cuit) throw new validar.Invalido(`El certificado es del CUIT ${info.cuit}, no del tuyo.`)
    // La condición repite los controles en la base, por si el CUIT o la clave cambiaron mientras tanto.
    const [guardado] = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE usuarios SET certificado = ? WHERE id = ? AND cuit = ? AND clave_publica = ?").bind(pem, u.id, info.cuit, u.clave_publica),
      c.env.DB.prepare("DELETE FROM tickets WHERE usuario_id = ?").bind(u.id),
    ])
    if (!guardado.meta.changes) throw new validar.Invalido("Tus datos cambiaron mientras subías el certificado. Recargá la página y probá de nuevo.")
    return c.json(vistaCuenta(c.env, { ...u, certificado: pem }))
  })

  app.put("/api/cuenta/whatsapp", async (c) => {
    const u = c.get("usuario")
    const cuerpo = await c.req.json().catch(() => ({}))
    const mensaje = typeof cuerpo.mensaje === "string" ? cuerpo.mensaje.trim() : ""
    if (!mensaje) throw new validar.Invalido("Escribí el mensaje")
    if (mensaje.length > 1000) throw new validar.Invalido("El mensaje es demasiado largo")
    if (!mensaje.includes("{enlace}")) throw new validar.Invalido("El mensaje tiene que incluir {enlace}, que es por donde se descarga la factura")
    await c.env.DB.prepare("UPDATE usuarios SET mensaje_whatsapp = ? WHERE id = ?").bind(mensaje, u.id).run()
    return c.json(vistaCuenta(c.env, { ...u, mensaje_whatsapp: mensaje }))
  })

  app.put("/api/cuenta/clave", async (c) => {
    const u = c.get("usuario")
    const { actual, nueva } = await c.req.json().catch(() => ({}))
    const limites = [{ clave: `cambio-clave:${u.id}`, maximo: auth.LIMITES.cambioClave }]
    if (!(await auth.registrarIntento(c.env.DB, limites))) {
      return c.json({ detail: "Demasiados intentos. Esperá unos minutos y probá de nuevo." }, 429)
    }
    if (typeof actual !== "string" || !(await auth.verificarClave(actual, u.clave_hash))) {
      throw new validar.Invalido("La contraseña actual no es correcta")
    }
    const hash = await auth.hashearClave(validar.claveNueva(nueva))
    await c.env.DB.prepare("UPDATE usuarios SET clave_hash = ? WHERE id = ?").bind(hash, u.id).run()
    await auth.cerrarOtrasSesiones(c.env.DB, u.id, c.get("token"))
    await auth.limpiarIntentos(c.env.DB, [limites[0].clave])
    return c.json({ ok: true })
  })

  app.get("/api/pacientes", async (c) => {
    return c.json((await datos.pacientes(c.env.DB, c.get("usuario").id)).map(vistaPaciente))
  })

  app.put("/api/pacientes/:dni", async (c) => {
    const p = validar.paciente(await c.req.json().catch(() => null), c.req.param("dni"))
    await datos.guardarPaciente(c.env.DB, c.get("usuario").id, p)
    return c.json(vistaPaciente(p))
  })

  app.delete("/api/pacientes/:dni", async (c) => {
    if (!(await datos.borrarPaciente(c.env.DB, c.get("usuario").id, validar.dni(c.req.param("dni"))))) {
      return c.json({ detail: "Paciente no encontrado" }, 404)
    }
    return c.json({ ok: true })
  })

  app.post("/api/duplicados", async (c) => {
    const u = c.get("usuario")
    const cuerpo = await c.req.json().catch(() => ({}))
    const dnis = (Array.isArray(cuerpo.dnis) ? cuerpo.dnis : []).map((d: unknown) => Number(String(d).replace(/\D/g, ""))).filter(Boolean)
    const desde = String(cuerpo.desde ?? "")
    const hasta = String(cuerpo.hasta ?? "")
    return c.json(await datos.yaFacturados(c.env.DB, u.id, modoDe(c.env), dnis.slice(0, 200), desde, hasta))
  })

  app.post("/api/lotes", async (c) => {
    const lote = validar.lote(await c.req.json().catch(() => null))
    return c.json(await facturarLote(c.env, c.get("usuario"), lote, dep(c.env)))
  })

  app.get("/api/facturas", async (c) => {
    const u = c.get("usuario")
    const facturas = await datos.historial(c.env.DB, u.id, modoDe(c.env))
    for (const f of facturas as Record<string, unknown>[]) {
      f.enlace = await enlacePublico(c.env.SECRETO_DATOS, { id: f.id as number, enlace_version: f.enlace_version as number })
    }
    return c.json(facturas)
  })

  app.post("/api/facturas/:id/anular-enlace", async (c) => {
    const f = await c.env.DB.prepare(
      "UPDATE facturas SET enlace_version = enlace_version + 1 WHERE id = ? AND usuario_id = ? RETURNING id, enlace_version",
    )
      .bind(Number(c.req.param("id")), c.get("usuario").id)
      .first<{ id: number; enlace_version: number }>()
    if (!f) return c.json({ detail: "Factura no encontrada" }, 404)
    return c.json({ enlace: await enlacePublico(c.env.SECRETO_DATOS, f) })
  })

  app.post("/api/facturas/:id/whatsapp", async (c) => {
    const id = Number(c.req.param("id"))
    if (!(await marcarWhatsApp(c.env, c.get("usuario"), id))) return c.json({ detail: "Factura no encontrada" }, 404)
    return c.json({ estado: "abierto" })
  })

  // La página principal pasa por el chequeo de sesión: sin sesión va directo a /login, sin mostrar la app un instante.
  app.get("/", async (c) => {
    const r = await c.env.ASSETS.fetch(c.req.raw)
    return new Response(r.body, r)
  })

  app.get("/facturas/:archivo", async (c) => {
    const id = Number(c.req.param("archivo").replace(/\.pdf$/, ""))
    const f = Number.isInteger(id) ? await datos.factura(c.env.DB, c.get("usuario").id, id) : null
    if (!f) return c.json({ detail: "Factura no encontrada" }, 404)
    const disposicion = c.req.query("descargar") ? "attachment" : "inline"
    return new Response(await pdfDe(c.env, f), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `${disposicion}; filename="${nombreArchivo(f)}"` },
    })
  })

  app.get("/lotes/:archivo", async (c) => {
    const lote = c.req.param("archivo").replace(/\.zip$/, "")
    const facturas = await datos.facturasLote(c.env.DB, c.get("usuario").id, lote)
    if (!facturas.length) return c.json({ detail: "Tanda no encontrada" }, 404)
    const archivos: Record<string, Uint8Array> = {}
    for (const f of facturas) archivos[nombreArchivo(f)] = await pdfDe(c.env, f)
    return new Response(zipSync(archivos, { level: 0 }), {
      headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="Facturas-${facturas[0].fecha}.zip"` },
    })
  })

  return app
}
