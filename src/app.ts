import { Hono, type Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { zipSync } from "fflate"
import * as auth from "./auth"
import { cifrar } from "./cifrado"
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
import { enlacePublico, idDeEnlace } from "./enlaces"
import { certificadoDesdeArchivo, generarClaveYPedido, leerCertificado } from "./arca/certificado"

export const NOMBRE_APP = "Facturación"

type Variables = { usuario: Usuario; token: string }
type Ctx = Context<{ Bindings: Env; Variables: Variables }>

const CABECERAS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
}

function cookieSegura(c: Ctx): boolean {
  return c.env.COOKIE_SEGURA !== "false"
}

function ponerCookie(c: Ctx, token: string) {
  setCookie(c, auth.COOKIE, token, {
    httpOnly: true,
    secure: cookieSegura(c),
    sameSite: "Strict",
    path: "/",
    maxAge: auth.DURACION_SESION,
  })
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
    precio_sesion: u.precio_sesion,
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
    if (!["GET", "HEAD"].includes(c.req.method) && origen && new URL(origen).host !== new URL(c.req.url).host) {
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
    if (await auth.bloqueado(c.env.DB, usuario)) {
      return c.json({ detail: "Demasiados intentos. Esperá unos minutos y probá de nuevo." }, 429)
    }
    const encontrado = await auth.buscarParaLogin(c.env.DB, usuario, clave)
    if (!encontrado) {
      await auth.registrarFallo(c.env.DB, usuario)
      return c.json({ detail: "El usuario o la contraseña no son correctos." }, 401)
    }
    await auth.limpiarFallos(c.env.DB, usuario)
    ponerCookie(c, await auth.crearSesion(c.env.DB, encontrado.id))
    return c.json({ ok: true })
  })

  app.post("/api/logout", async (c) => {
    await auth.cerrarSesion(c.env.DB, getCookie(c, auth.COOKIE))
    deleteCookie(c, auth.COOKIE, { path: "/", secure: cookieSegura(c) })
    return c.json({ ok: true })
  })

  app.get("/f/:clave", async (c) => {
    const id = await idDeEnlace(c.env.SECRETO_DATOS, c.req.param("clave").replace(/\.pdf$/, ""))
    const f = id ? await c.env.DB.prepare("SELECT * FROM facturas WHERE id = ?").bind(id).first<Factura>() : null
    if (!f) return c.text("Este enlace no es válido.", 404)
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
    const token = getCookie(c, auth.COOKIE)
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
    const d = validar.datosCuenta(await c.req.json().catch(() => null))
    await c.env.DB.prepare(
      "UPDATE usuarios SET nombre = ?, titulo = ?, cuit = ?, domicilio = ?, iibb = ?, inicio_actividades = ?, " +
        "punto_venta = ?, precio_sesion = ?, descripcion = ? WHERE id = ?",
    )
      .bind(d.nombre, d.titulo, d.cuit, d.domicilio, d.iibb, d.inicio_actividades, d.punto_venta, d.precio_sesion, d.descripcion, u.id)
      .run()
    return c.json(vistaCuenta(c.env, { ...u, ...d }))
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
    if (info.cuit && info.cuit !== u.cuit) throw new validar.Invalido(`El certificado es del CUIT ${info.cuit}, no del tuyo.`)
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE usuarios SET certificado = ? WHERE id = ?").bind(pem, u.id),
      c.env.DB.prepare("DELETE FROM tickets WHERE usuario_id = ?").bind(u.id),
    ])
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
    if (typeof actual !== "string" || !(await auth.verificarClave(actual, u.clave_hash))) {
      throw new validar.Invalido("La contraseña actual no es correcta")
    }
    const hash = await auth.hashearClave(validar.claveNueva(nueva))
    await c.env.DB.prepare("UPDATE usuarios SET clave_hash = ? WHERE id = ?").bind(hash, u.id).run()
    await auth.cerrarOtrasSesiones(c.env.DB, u.id, c.get("token"))
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
    for (const f of facturas as Record<string, unknown>[]) f.enlace = await enlacePublico(c.env.SECRETO_DATOS, f.id as number)
    return c.json(facturas)
  })

  app.post("/api/facturas/:id/whatsapp", async (c) => {
    const id = Number(c.req.param("id"))
    if (!(await marcarWhatsApp(c.env, c.get("usuario"), id))) return c.json({ detail: "Factura no encontrada" }, 404)
    return c.json({ estado: "abierto" })
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
