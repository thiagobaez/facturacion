import { execFileSync } from "node:child_process"
import { pbkdf2Sync, randomBytes } from "node:crypto"
import { createInterface } from "node:readline"
import { Writable } from "node:stream"

// Igual que src/auth.ts: rondas encadenadas de 100.000, el máximo que acepta Workers por llamada.
const ITERACIONES = 600_000
const RONDA = 100_000
const [, , comando, nombre, ...resto] = process.argv
const remoto = resto.includes("--remoto")

function ayuda() {
  console.log(`Uso:
  npm run usuario -- nuevo <usuario> [--remoto]    crea una cuenta
  npm run usuario -- clave <usuario> [--remoto]    cambia la contraseña
  npm run usuario -- borrar <usuario> [--remoto]   borra la cuenta y todos sus datos
  npm run usuario -- lista [--remoto]              muestra las cuentas

Sin --remoto trabaja sobre la base local de "npm run dev".`)
  process.exit(1)
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function hashear(clave) {
  const sal = randomBytes(16)
  let resumen = Buffer.from(clave, "utf8")
  for (let restantes = ITERACIONES; restantes > 0; restantes -= RONDA) {
    resumen = pbkdf2Sync(resumen, sal, Math.min(restantes, RONDA), 32, "sha256")
  }
  return `pbkdf2:${ITERACIONES}:${base64url(sal)}:${base64url(resumen)}`
}

function sql(texto) {
  return `'${texto.replace(/'/g, "''")}'`
}

function ejecutar(consulta) {
  const salida = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "facturacion", remoto ? "--remote" : "--local", "--json", "--command", consulta],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  )
  return JSON.parse(salida)[0]
}

function preguntarOculto(pregunta) {
  let silencio = false
  const salida = new Writable({
    write(trozo, codificacion, listo) {
      if (!silencio) process.stdout.write(trozo, codificacion)
      listo()
    },
  })
  const rl = createInterface({ input: process.stdin, output: salida, terminal: true })
  return new Promise((resolver) => {
    rl.question(pregunta, (respuesta) => {
      rl.close()
      process.stdout.write("\n")
      resolver(respuesta)
    })
    silencio = true
  })
}

async function pedirClave() {
  const clave = await preguntarOculto("Contraseña (mínimo 10 caracteres): ")
  if (clave.length < 10) {
    console.error("Tiene que tener al menos 10 caracteres.")
    process.exit(1)
  }
  if ((await preguntarOculto("Repetila: ")) !== clave) {
    console.error("No coinciden.")
    process.exit(1)
  }
  return clave
}

function validarNombre() {
  if (!nombre || !/^[A-Za-z0-9._-]{3,40}$/.test(nombre)) {
    console.error("El usuario tiene que tener entre 3 y 40 caracteres: letras, números, punto, guion o guion bajo.")
    process.exit(1)
  }
}

if (comando === "lista") {
  const { results } = ejecutar("SELECT usuario, nombre, cuit, modo, creado FROM usuarios ORDER BY usuario")
  if (!results.length) console.log("No hay cuentas todavía.")
  for (const u of results) console.log(`${u.usuario.padEnd(20)} ${u.nombre || "(sin nombre)"}  ${u.cuit || ""}  ${u.modo}`)
} else if (comando === "nuevo") {
  validarNombre()
  const existe = ejecutar(`SELECT id FROM usuarios WHERE usuario = ${sql(nombre)}`).results.length
  if (existe) {
    console.error(`Ya existe el usuario ${nombre}.`)
    process.exit(1)
  }
  const clave = await pedirClave()
  ejecutar(`INSERT INTO usuarios (usuario, clave_hash) VALUES (${sql(nombre)}, ${sql(hashear(clave))})`)
  console.log(`Listo: ya podés entrar como "${nombre}".`)
} else if (comando === "clave") {
  validarNombre()
  const clave = await pedirClave()
  const r = ejecutar(`UPDATE usuarios SET clave_hash = ${sql(hashear(clave))} WHERE usuario = ${sql(nombre)}`)
  if (!r.meta.changes) {
    console.error(`No existe el usuario ${nombre}.`)
    process.exit(1)
  }
  ejecutar(`DELETE FROM sesiones WHERE usuario_id = (SELECT id FROM usuarios WHERE usuario = ${sql(nombre)})`)
  console.log("Contraseña cambiada. Se cerraron las sesiones abiertas.")
} else if (comando === "borrar") {
  validarNombre()
  const confirmacion = await preguntarOculto(`Escribí "${nombre}" para confirmar que querés borrar la cuenta y todos sus datos: `)
  if (confirmacion !== nombre) {
    console.error("No coincide, no se borró nada.")
    process.exit(1)
  }
  const id = ejecutar(`SELECT id FROM usuarios WHERE usuario = ${sql(nombre)}`).results[0]?.id
  if (!id) {
    console.error(`No existe el usuario ${nombre}.`)
    process.exit(1)
  }
  const facturas = ejecutar(`SELECT id FROM facturas WHERE usuario_id = ${id}`).results
  for (const f of facturas) {
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "delete", `facturacion-pdfs/u/${id}/facturas/${f.id}.pdf`, remoto ? "--remote" : "--local"],
      { stdio: "ignore" },
    )
  }
  ejecutar(
    `DELETE FROM sesiones WHERE usuario_id = ${id}; DELETE FROM tickets WHERE usuario_id = ${id}; ` +
      `DELETE FROM candados WHERE usuario_id = ${id}; DELETE FROM pendientes WHERE usuario_id = ${id}; DELETE FROM pacientes WHERE usuario_id = ${id}; ` +
      `DELETE FROM facturas WHERE usuario_id = ${id}; DELETE FROM usuarios WHERE id = ${id};`,
  )
  console.log(`Cuenta borrada, con sus ${facturas.length} PDF.`)
} else {
  ayuda()
}
