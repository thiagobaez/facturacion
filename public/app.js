const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const pacientes = new Map();
let BORRADOR = null;

const moneda = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const pesos = n => moneda.format(n || 0);

function leerPrecio(texto) {
	const t = String(texto || '').replace(/[^\d.,]/g, '');
	if (!t) return 0;
	if (t.includes(',')) return parseFloat(t.replace(/\./g, '').replace(',', '.')) || 0;
	if (/^\d{1,3}(\.\d{3})+$/.test(t)) return parseFloat(t.replace(/\./g, '')) || 0;
	return parseFloat(t) || 0;
}

const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dmy = s => s.split('-').reverse().join('/');
const nombreMes = s => new Date(s + 'T12:00').toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
const mayuscula = t => t.charAt(0).toUpperCase() + t.slice(1);
const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

function escapar(t) {
	return String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(url, opciones = {}) {
	const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opciones });
	if (r.status === 401) {
		location.replace('/login');
		throw new Error('Tu sesión terminó. Volvé a ingresar.');
	}
	const datos = await r.json().catch(() => null);
	if (!r.ok) throw Object.assign(new Error(datos?.detail || 'Algo salió mal. Probá de nuevo.'), { estado: r.status, datos });
	return datos;
}

function mesDe(desplazamiento) {
	const hoy = new Date();
	return {
		desde: iso(new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento, 1)),
		hasta: iso(new Date(hoy.getFullYear(), hoy.getMonth() + desplazamiento + 1, 0)),
	};
}

const tanda = {
	paso: 1,
	periodo: new Date().getDate() <= 15 ? 'pasado' : 'actual',
	desde: '',
	hasta: '',
	precio: '',
	fecha: iso(new Date()),
	vto: iso(new Date()),
	descripcion: '',
	sel: new Map(),
	extras: new Map(),
};

let ultimaTanda = [];
let fallidas = [];
let periodoEmitido = null;
let simulacion = false;

function rango() {
	if (tanda.periodo === 'pasado') return mesDe(-1);
	if (tanda.periodo === 'actual') return mesDe(0);
	return { desde: tanda.desde, hasta: tanda.hasta };
}

function describirRango({ desde, hasta }) {
	if (!desde || !hasta) return 'Elegí las fechas';
	const ultimoDia = new Date(+hasta.slice(0, 4), +hasta.slice(5, 7), 0).getDate();
	if (desde.slice(0, 7) === hasta.slice(0, 7) && desde.endsWith('-01') && +hasta.slice(8) === ultimoDia) {
		return mayuscula(nombreMes(desde));
	}
	return `Del ${dmy(desde)} al ${dmy(hasta)}`;
}

function guardar() {
	if (!BORRADOR) return;
	try {
		localStorage.setItem(BORRADOR, JSON.stringify({
			periodo: tanda.periodo, desde: tanda.desde, hasta: tanda.hasta, precio: tanda.precio,
			vto: tanda.vto, descripcion: tanda.descripcion,
			sel: [...tanda.sel.values()], extras: [...tanda.extras.values()],
		}));
	} catch {}
}

function leerBorrador() {
	if (!BORRADOR) return null;
	try { return JSON.parse(localStorage.getItem(BORRADOR)) || null; } catch { return null; }
}

function marcar(input, mal) {
	input.setAttribute('aria-invalid', mal ? 'true' : 'false');
	return mal;
}

function mostrarError(texto) {
	$('#error').textContent = texto;
	$('#error').hidden = !texto;
}

function totales() {
	const precio = leerPrecio(tanda.precio);
	const items = [...tanda.sel.values()];
	const sesiones = items.reduce((a, i) => a + i.sesiones, 0);
	return { precio, items, sesiones, total: precio * sesiones };
}

function pintarPeriodo() {
	const opciones = [
		['pasado', mayuscula(nombreMes(mesDe(-1).desde)), 'Mes pasado'],
		['actual', mayuscula(nombreMes(mesDe(0).desde)), 'Este mes'],
		['otro', 'Otras fechas', 'Elegís desde y hasta'],
	];
	$('#opciones-periodo').innerHTML = opciones.map(([valor, titulo, detalle]) => `
		<button type="button" role="radio" aria-checked="${tanda.periodo === valor}" data-periodo="${valor}">
			<b>${titulo}</b><small>${detalle}</small>
		</button>`).join('');
	$('#fechas-otras').hidden = tanda.periodo !== 'otro';
	$('#desde').value = tanda.desde;
	$('#hasta').value = tanda.hasta;
	$('#precio').value = tanda.precio;
}

function todosLosPacientes() {
	const lista = new Map(pacientes);
	for (const [dni, p] of tanda.extras) if (!lista.has(dni)) lista.set(dni, { ...p, nuevo: true });
	return [...lista.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

function pintarElegir() {
	const q = $('#buscar-tanda').value.trim().toLowerCase();
	const precio = leerPrecio(tanda.precio);
	const todos = todosLosPacientes();
	const lista = todos.filter(p => !q || p.nombre.toLowerCase().includes(q) || String(p.dni).includes(q));
	$('#repetir').hidden = !ultimaTanda.length;
	if (!todos.length) {
		$('#elegir').innerHTML = '<li class="vacio-li"><p class="vacio">Todavía no tenés pacientes. Agregá el primero.</p></li>';
		return;
	}
	$('#elegir').innerHTML = lista.length ? lista.map(p => {
		const elegido = tanda.sel.get(String(p.dni));
		const detalle = [`DNI ${p.dni}`, p.obra_social && escapar([p.obra_social, p.plan].filter(Boolean).join(' ')), p.telefono_visible && 'WhatsApp', p.nuevo && 'nuevo'].filter(Boolean).join(' · ');
		return `<li class="elegible${elegido ? ' elegido' : ''}" data-dni="${p.dni}">
			<button type="button" class="tocar" aria-pressed="${!!elegido}">
				<span class="check" aria-hidden="true"></span>
				<span class="quien"><b>${escapar(p.nombre)}</b><small>${detalle}</small></span>
			</button>
			${elegido ? `<div class="contador">
				<button type="button" class="menos" aria-label="Una sesión menos">−</button>
				<input type="text" inputmode="numeric" value="${elegido.sesiones}" aria-label="Sesiones de ${escapar(p.nombre)}">
				<button type="button" class="mas" aria-label="Una sesión más">+</button>
			</div>
			<span class="importe">${pesos(precio * elegido.sesiones)}</span>` : ''}
		</li>`;
	}).join('') : '<li class="vacio-li"><p class="vacio">No hay pacientes que coincidan.</p></li>';
}

async function pintarRevision() {
	const { precio, items, total } = totales();
	$('#revision-periodo').textContent = `${describirRango(rango())} · ${pesos(precio)} por sesión`;
	$('#revision').innerHTML = items.map(i => `<li>
		<span class="marca">${i.sesiones}</span>
		<span><b>${escapar(i.nombre)}</b> <span class="dato">· ${plural(i.sesiones, 'sesión', 'sesiones')}${pacientes.get(i.dni)?.obra_social ? ` · ${escapar(pacientes.get(i.dni).obra_social)}` : ''}${pacientes.get(i.dni)?.telefono ? ' · con WhatsApp' : ''}</span></span>
		<span class="monto">${pesos(precio * i.sesiones)}</span>
	</li>`).join('');
	$('#revision-total').textContent = pesos(total);
	$('#fecha').value = tanda.fecha;
	$('#vto_pago').value = tanda.vto;
	$('#descripcion').value = tanda.descripcion;
	pintarDetalles();
	$('#aviso-dup').hidden = true;
	try {
		const { desde, hasta } = rango();
		const repetidos = await api('/api/duplicados', { method: 'POST', body: JSON.stringify({ desde, hasta, dnis: items.map(i => i.dni) }) });
		const nombres = items.filter(i => repetidos.includes(+i.dni)).map(i => i.nombre);
		$('#aviso-dup').textContent = nombres.length
			? `Ojo: a ${new Intl.ListFormat('es').format(nombres)} ya ${nombres.length === 1 ? 'le' : 'les'} facturaste algo en este período.`
			: '';
		$('#aviso-dup').hidden = !nombres.length;
	} catch {}
}

function pintarDetalles() {
	const vence = tanda.vto === tanda.fecha ? 'vence el mismo día' : `vence el ${dmy(tanda.vto)}`;
	$('#detalles-resumen').textContent = `Factura del ${dmy(tanda.fecha)}, ${vence} · ${tanda.descripcion}`;
}

function pintarBarra() {
	const { precio, items, sesiones, total } = totales();
	const siguiente = $('#siguiente');
	$('#atras').hidden = tanda.paso === 1;
	if (tanda.paso === 1) {
		$('#resumen').innerHTML = `${escapar(describirRango(rango()))}${precio ? ` · <b>${pesos(precio)}</b> por sesión` : ''}`;
		siguiente.textContent = 'Elegir pacientes';
	} else {
		$('#resumen').innerHTML = items.length
			? `${plural(items.length, 'paciente', 'pacientes')} · ${plural(sesiones, 'sesión', 'sesiones')} · <b>${pesos(total)}</b>`
			: 'Todavía no elegiste a nadie';
		siguiente.textContent = tanda.paso === 2 ? 'Revisar' : `Emitir ${plural(items.length, 'factura', 'facturas')}`;
	}
	siguiente.disabled = tanda.paso > 1 && !items.length;
}

function irAPaso(paso) {
	tanda.paso = paso;
	$$('.paso').forEach(s => { s.hidden = +s.dataset.paso !== paso; });
	$$('.pasos-tanda li').forEach(li => {
		li.classList.toggle('actual', +li.dataset.paso === paso);
		li.classList.toggle('hecho', +li.dataset.paso < paso);
	});
	mostrarError('');
	if (paso === 1) pintarPeriodo();
	if (paso === 2) pintarElegir();
	if (paso === 3) pintarRevision();
	pintarBarra();
	guardar();
	window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validarPaso1() {
	const { desde, hasta } = rango();
	if (tanda.periodo === 'otro') {
		if (marcar($('#desde'), !desde) | marcar($('#hasta'), !hasta)) return 'Elegí desde y hasta qué fecha.';
		if (desde > hasta) return marcar($('#hasta'), true) && 'El período termina antes de empezar.';
	}
	if (marcar($('#precio'), leerPrecio(tanda.precio) <= 0)) return 'Poné cuánto cuesta cada sesión.';
	return '';
}

function validarPaso3() {
	if (marcar($('#fecha'), !tanda.fecha) || marcar($('#vto_pago'), !tanda.vto)) return 'Completá las fechas de la factura.';
	if (tanda.vto < tanda.fecha) return marcar($('#vto_pago'), true) && 'El vencimiento no puede ser antes de la fecha de la factura.';
	const dias = Math.abs((Date.parse(tanda.fecha) - Date.parse(iso(new Date()))) / 86400000);
	if (dias > 10) return marcar($('#fecha'), true) && 'ARCA solo acepta facturas con fecha de hasta 10 días antes o después de hoy.';
	if (marcar($('#descripcion'), tanda.descripcion.trim().length < 3)) return 'Escribí el concepto de la factura.';
	return '';
}

$('#siguiente').addEventListener('click', () => {
	if (tanda.paso === 1) {
		const problema = validarPaso1();
		if (problema) return mostrarError(problema);
		return irAPaso(2);
	}
	if (tanda.paso === 2) return irAPaso(3);
	const problema = validarPaso3();
	if (problema) {
		$('#detalles').open = true;
		return mostrarError(problema);
	}
	emitir();
});

$('#atras').addEventListener('click', () => irAPaso(tanda.paso - 1));

$$('.pasos-tanda li').forEach(li => li.addEventListener('click', () => {
	const paso = +li.dataset.paso;
	if (paso < tanda.paso) irAPaso(paso);
}));

$('#opciones-periodo').addEventListener('click', e => {
	const boton = e.target.closest('[data-periodo]');
	if (!boton) return;
	tanda.periodo = boton.dataset.periodo;
	if (tanda.periodo === 'otro' && !tanda.desde) Object.assign(tanda, mesDe(-1));
	pintarPeriodo();
	pintarBarra();
	guardar();
	if (tanda.periodo === 'otro') $('#desde').focus();
});

for (const id of ['desde', 'hasta']) {
	$(`#${id}`).addEventListener('input', e => {
		tanda[id] = e.target.value;
		e.target.removeAttribute('aria-invalid');
		pintarBarra();
		guardar();
	});
}

$('#precio').addEventListener('input', e => {
	tanda.precio = e.target.value;
	e.target.removeAttribute('aria-invalid');
	pintarBarra();
	guardar();
});

$('#precio').addEventListener('blur', e => {
	const n = leerPrecio(e.target.value);
	if (n) e.target.value = tanda.precio = n.toLocaleString('es-AR', { maximumFractionDigits: 2 });
});

$('#fecha').addEventListener('input', e => {
	tanda.fecha = e.target.value;
	if (tanda.vto < tanda.fecha) tanda.vto = $('#vto_pago').value = tanda.fecha;
	e.target.removeAttribute('aria-invalid');
	pintarDetalles();
});

$('#vto_pago').addEventListener('input', e => {
	tanda.vto = e.target.value;
	e.target.removeAttribute('aria-invalid');
	pintarDetalles();
	guardar();
});

$('#descripcion').addEventListener('input', e => {
	tanda.descripcion = e.target.value;
	e.target.removeAttribute('aria-invalid');
	pintarDetalles();
	guardar();
});

$('#buscar-tanda').addEventListener('input', pintarElegir);

function cambiarSesiones(dni, valor) {
	const elegido = tanda.sel.get(dni);
	if (!elegido) return;
	elegido.sesiones = Math.min(100, Math.max(1, valor || 1));
	const li = $(`.elegible[data-dni="${dni}"]`);
	if (li) {
		$('.contador input', li).value = elegido.sesiones;
		$('.importe', li).textContent = pesos(leerPrecio(tanda.precio) * elegido.sesiones);
	}
	pintarBarra();
	guardar();
}

$('#elegir').addEventListener('click', e => {
	const li = e.target.closest('.elegible');
	if (!li) return;
	const dni = li.dataset.dni;
	const elegido = tanda.sel.get(dni);
	if (e.target.closest('.mas')) return cambiarSesiones(dni, elegido.sesiones + 1);
	if (e.target.closest('.menos')) return cambiarSesiones(dni, elegido.sesiones - 1);
	if (!e.target.closest('.tocar')) return;
	if (elegido) tanda.sel.delete(dni);
	else {
		const p = pacientes.get(dni) || tanda.extras.get(dni);
		tanda.sel.set(dni, { dni, nombre: p.nombre, sesiones: 4 });
	}
	pintarElegir();
	pintarBarra();
	guardar();
});

$('#elegir').addEventListener('input', e => {
	const li = e.target.closest('.elegible');
	if (li && e.target.matches('.contador input')) cambiarSesiones(li.dataset.dni, parseInt(e.target.value, 10));
});

$('#repetir').addEventListener('click', () => {
	tanda.sel.clear();
	for (const f of ultimaTanda) tanda.sel.set(String(f.dni), { dni: String(f.dni), nombre: f.nombre, sesiones: f.sesiones });
	pintarElegir();
	pintarBarra();
	guardar();
});

const nuevoTanda = $('#nuevo-tanda');

function errorNuevo(texto) {
	$('#nuevo-error').textContent = texto;
	$('#nuevo-error').hidden = !texto;
}

$('#nuevo-en-tanda').addEventListener('click', () => {
	nuevoTanda.reset();
	errorNuevo('');
	nuevoTanda.hidden = false;
	$('#acciones-tanda').hidden = true;
	nuevoTanda.dni.focus();
});

$('#cancelar-nuevo').addEventListener('click', () => {
	nuevoTanda.hidden = true;
	$('#acciones-tanda').hidden = false;
});

nuevoTanda.addEventListener('input', e => e.target.removeAttribute('aria-invalid'));

nuevoTanda.addEventListener('submit', e => {
	e.preventDefault();
	const dni = nuevoTanda.dni.value.replace(/\D/g, '');
	const nombre = nuevoTanda.nombre.value.trim().replace(/\s+/g, ' ');
	if (marcar(nuevoTanda.dni, !/^\d{6,8}$/.test(dni))) return errorNuevo('El DNI debe tener entre 6 y 8 números.');
	const existente = pacientes.get(dni) || tanda.extras.get(dni);
	if (!existente && marcar(nuevoTanda.nombre, nombre.length < 2)) return errorNuevo('Escribí el nombre y apellido.');
	if (!existente) tanda.extras.set(dni, { dni, nombre });
	tanda.sel.set(dni, { dni, nombre: existente?.nombre || nombre, sesiones: tanda.sel.get(dni)?.sesiones || 4 });
	nuevoTanda.hidden = true;
	$('#acciones-tanda').hidden = false;
	$('#buscar-tanda').value = '';
	pintarElegir();
	pintarBarra();
	guardar();
});

$('#mostrar-pegar').addEventListener('click', () => { $('#pegar').hidden = false; $('#pegado').focus(); });
$('#cancelar-pegar').addEventListener('click', () => { $('#pegar').hidden = true; $('#pegado').value = ''; });

$('#importar').addEventListener('click', () => {
	let agregados = 0;
	for (const linea of $('#pegado').value.split(/\r?\n/)) {
		const partes = linea.split(/\t|;|,(?=\s*\S)/).map(p => p.trim()).filter(Boolean);
		const crudo = partes.find(p => /^[\d.\s]{6,11}$/.test(p) && p.replace(/\D/g, '').length >= 6);
		if (!crudo) continue;
		const dni = crudo.replace(/\D/g, '');
		const sesiones = [...partes].reverse().find(p => p !== crudo && /^\d{1,3}$/.test(p));
		const conocido = pacientes.get(dni) || tanda.extras.get(dni);
		const nombre = conocido?.nombre || partes.find(p => p !== crudo && p !== sesiones) || '';
		if (!nombre) continue;
		if (!conocido) tanda.extras.set(dni, { dni, nombre });
		tanda.sel.set(dni, { dni, nombre, sesiones: Math.min(100, Math.max(1, parseInt(sesiones, 10) || 1)) });
		agregados++;
	}
	if (!agregados) return;
	$('#pegado').value = '';
	$('#pegar').hidden = true;
	pintarElegir();
	pintarBarra();
	guardar();
});

async function emitir() {
	const { desde, hasta } = rango();
	const { precio, items } = totales();
	const pedido = {
		fecha: tanda.fecha, vto_pago: tanda.vto, desde, hasta, precio: precio.toFixed(2),
		descripcion: tanda.descripcion.trim(), items: items.map(({ dni, nombre, sesiones }) => ({ dni, nombre, sesiones })),
	};
	$('#asistente').hidden = true;
	$('#emitiendo').hidden = false;
	window.scrollTo({ top: 0, behavior: 'smooth' });
	try {
		const respuesta = await api('/api/lotes', { method: 'POST', body: JSON.stringify(pedido) });
		periodoEmitido = { desde, hasta };
		mostrarResultado(respuesta);
		$('#resultado-ayuda').hidden = !respuesta.resultados.some(r => r.ok && pacientes.get(String(r.dni))?.telefono);
		tanda.sel = new Map(fallidas.map(f => [String(f.dni), { dni: String(f.dni), nombre: f.nombre, sesiones: f.sesiones }]));
		for (const r of respuesta.resultados) if (r.ok) tanda.extras.delete(String(r.dni));
		guardar();
		cargarPacientes();
		cargarUltimaTanda();
	} catch (err) {
		$('#asistente').hidden = false;
		mostrarError(err.message);
	} finally {
		$('#emitiendo').hidden = true;
	}
}

function mostrarResultado({ lote: id, aprobadas, recuperadas, resultados }) {
	if (recuperadas) {
		alert(`${recuperadas === 1 ? 'Una factura de una tanda anterior había quedado' : `${recuperadas} facturas de una tanda anterior habían quedado`} sin guardar porque se cortó la conexión. ARCA ${recuperadas === 1 ? 'la había emitido: ya está' : 'las había emitido: ya están'} en el historial.`);
	}
	fallidas = resultados.filter(r => !r.ok);
	const total = resultados.length;
	$('#resultado-titular').textContent = !fallidas.length
		? `Se ${aprobadas === 1 ? 'emitió la factura' : `emitieron las ${aprobadas} facturas`}.`
		: aprobadas
			? `Se emitieron ${aprobadas} de ${total}. ${fallidas.length === 1 ? 'Una no pudo salir' : `${fallidas.length} no pudieron salir`}.`
			: 'No se pudo emitir ninguna factura.';
	$('#resultado').querySelector('h2').textContent = fallidas.length ? 'Resultado' : 'Listo';
	$('#resultado-lista').innerHTML = resultados.map((r, n) => r.ok
		? `<li style="animation-delay:${n * 40}ms"><span class="marca">✓</span><span><b>${escapar(r.nombre)}</b> <span class="dato">· N.º ${String(r.numero).padStart(8, '0')}</span></span><span class="monto">${pesos(+r.total)}</span><a class="ver" href="/facturas/${r.factura_id}.pdf" target="_blank" rel="noopener">Ver</a>${lineaEnvio({ id: r.factura_id, dni: r.dni, nombre: r.nombre, total: r.total, enlace: r.enlace, ...periodoEmitido })}</li>`
		: `<li class="mal" style="animation-delay:${n * 40}ms"><span class="marca">✕</span><span><b>${escapar(r.nombre)}</b> <span class="dato">· DNI ${r.dni}</span></span><span class="monto">${pesos(+r.total)}</span><span></span><span class="motivo">${escapar(r.errores.join(' · '))}</span></li>`
	).join('');
	$('#zip').hidden = !aprobadas;
	$('#zip').href = `/lotes/${id}.zip`;
	$('#zip').textContent = aprobadas === 1 ? 'Descargar PDF' : 'Descargar todas';
	if (aprobadas === 1) $('#zip').href = `/facturas/${resultados.find(r => r.ok).factura_id}.pdf?descargar=true`;
	$('#reintentar').hidden = !fallidas.length;
	$('#resultado').hidden = false;
}

function periodoTexto(desde, hasta) {
	if (desde && hasta && desde.slice(0, 7) === hasta.slice(0, 7)) return nombreMes(desde);
	return `${dmy(desde)} al ${dmy(hasta)}`;
}

function mensajeDe(plantilla, d) {
	const valores = {
		'{nombre}': (d.nombre || '').split(/\s+/)[0],
		'{periodo}': periodoTexto(d.desde, d.hasta),
		'{importe}': pesos(+d.total),
		'{enlace}': location.origin + d.enlace,
	};
	return plantilla.replace(/\{(nombre|periodo|importe|enlace)\}/g, v => valores[v]);
}

const datosEnvio = new Map();

function lineaEnvio(d) {
	datosEnvio.set(String(d.id), d);
	const telefono = d.telefono || pacientes.get(String(d.dni))?.telefono;
	let contenido;
	if (telefono) {
		const url = `https://wa.me/${telefono}?text=${encodeURIComponent(mensajeDe(cuenta.mensaje_whatsapp || '', d))}`;
		const abierto = d.estado === 'abierto' || d.estado === 'enviado';
		contenido = `${abierto ? '<span class="ok">✓ Abriste WhatsApp</span>' : ''}<a class="boton-whatsapp${abierto ? ' secundario' : ''}" href="${url}" target="_blank" rel="noopener" data-id="${d.id}">
			<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 1 1 3.3 6.2L4 19.5l1.2-3.4A7.5 7.5 0 0 1 4.5 12z"/></svg>${abierto ? 'Enviar de nuevo' : 'WhatsApp'}</a>`;
	} else {
		contenido = `<span>Sin teléfono</span><button type="button" class="enlace copiar-enlace" data-id="${d.id}">Copiar enlace de la factura</button>`;
	}
	contenido += `<button type="button" class="enlace anular-enlace" data-id="${d.id}">Anular enlace</button>`;
	return `<span class="linea-envio" data-id="${d.id}">${contenido}</span>`;
}

document.addEventListener('click', async e => {
	const boton = e.target.closest('.boton-whatsapp');
	if (boton) {
		const id = boton.dataset.id;
		const d = { ...datosEnvio.get(id), estado: 'abierto' };
		setTimeout(() => { boton.closest('.linea-envio').outerHTML = lineaEnvio(d); }, 300);
		api(`/api/facturas/${id}/whatsapp`, { method: 'POST' }).catch(() => {});
		return;
	}
	const anular = e.target.closest('.anular-enlace');
	if (anular) {
		const id = anular.dataset.id;
		if (!confirm('¿Anular el enlace de esta factura? Quien ya lo tenga no va a poder abrirla. Si después la volvés a mandar, sale con un enlace nuevo.')) return;
		try {
			const { enlace } = await api(`/api/facturas/${id}/anular-enlace`, { method: 'POST' });
			const d = { ...datosEnvio.get(id), enlace };
			const enHistorial = historial.find(f => String(f.id) === id);
			if (enHistorial) enHistorial.enlace = enlace;
			anular.closest('.linea-envio').outerHTML = lineaEnvio(d);
			alert('Listo: el enlace anterior ya no funciona.');
		} catch (error) {
			alert(error.message);
		}
		return;
	}
	const copiar = e.target.closest('.copiar-enlace');
	if (copiar) {
		const d = datosEnvio.get(copiar.dataset.id);
		try {
			await navigator.clipboard.writeText(location.origin + d.enlace);
			copiar.textContent = '¡Enlace copiado!';
		} catch {
			prompt('Copiá este enlace:', location.origin + d.enlace);
		}
	}
});

function volverAlAsistente(paso) {
	$('#resultado').hidden = true;
	$('#asistente').hidden = false;
	tanda.fecha = iso(new Date());
	if (tanda.vto < tanda.fecha) tanda.vto = tanda.fecha;
	irAPaso(paso);
}

$('#reintentar').addEventListener('click', () => volverAlAsistente(3));
$('#otra').addEventListener('click', () => {
	tanda.sel.clear();
	guardar();
	volverAlAsistente(1);
});

async function cargarUltimaTanda() {
	try {
		const facturas = await api('/api/facturas');
		const lote = facturas[0]?.lote;
		ultimaTanda = lote ? facturas.filter(f => f.lote === lote) : [];
	} catch {
		ultimaTanda = [];
	}
	if (tanda.paso === 2) pintarElegir();
}

$$('.tabs button').forEach(b => b.addEventListener('click', () => mostrarVista(b.dataset.vista)));

function mostrarVista(nombre) {
	$$('.tabs button').forEach(o => o.setAttribute('aria-selected', String(o.dataset.vista === nombre)));
	for (const vista of ['nueva', 'pacientes', 'historial', 'cuenta']) $(`#vista-${vista}`).hidden = nombre !== vista;
	if (nombre === 'cuenta') { pintarCuenta(); abrirPanel(null); }
	if (nombre === 'historial') cargarHistorial();
	if (nombre === 'pacientes') cargarPacientes().then(pintarPacientes);
}

let historial = [];

async function cargarHistorial() {
	try { historial = await api('/api/facturas'); } catch { historial = []; }
	pintarHistorial();
}

function pintarHistorial() {
	const q = $('#buscar').value.trim().toLowerCase();
	const lista = historial.filter(f => !q || f.nombre.toLowerCase().includes(q) || String(f.dni).includes(q));
	if (!lista.length) {
		$('#historial').innerHTML = `<p class="vacio">${historial.length ? 'No hay facturas que coincidan.' : 'Todavía no emitiste facturas.'}</p>`;
		return;
	}
	const grupos = new Map();
	for (const f of lista) {
		if (!grupos.has(f.fecha)) grupos.set(f.fecha, []);
		grupos.get(f.fecha).push(f);
	}
	$('#historial').innerHTML = [...grupos].map(([fecha, fs]) => `
		<p class="dia">${dmy(fecha)} · ${fs.length} ${fs.length === 1 ? 'factura' : 'facturas'} · ${pesos(fs.reduce((a, f) => a + +f.total, 0))}</p>
		<ol class="lista">${fs.map(f => `<li><span class="marca">✓</span><span><b>${escapar(f.nombre)}</b> <span class="dato">· N.º ${String(f.numero).padStart(8, '0')} · ${f.sesiones} ${f.sesiones === 1 ? 'sesión' : 'sesiones'} de ${nombreMes(f.desde)}</span></span><span class="monto">${pesos(+f.total)}</span><a class="ver" href="/facturas/${f.id}.pdf" target="_blank" rel="noopener">Ver</a>${lineaEnvio({ id: f.id, dni: f.dni, nombre: f.nombre, total: f.total, enlace: f.enlace, desde: f.desde, hasta: f.hasta, telefono: f.telefono, estado: f.whatsapp_estado })}</li>`).join('')}</ol>
	`).join('');
}

$('#buscar').addEventListener('input', pintarHistorial);

$('#salir').addEventListener('click', async () => {
	try { await fetch('/api/logout', { method: 'POST' }); } catch {}
	location.replace('/login');
});

async function cargarPacientes() {
	try {
		const lista = await api('/api/pacientes');
		pacientes.clear();
		for (const p of lista) pacientes.set(String(p.dni), p);
		if (tanda.paso === 2) pintarElegir();
	} catch {}
}

const ficha = $('#ficha');
let editando = null;

function pintarPacientes() {
	const q = $('#buscar-paciente').value.trim().toLowerCase();
	const todos = [...pacientes.values()];
	const lista = todos.filter(p => !q || p.nombre.toLowerCase().includes(q) || String(p.dni).includes(q));
	$('#lista-pacientes').innerHTML = lista.length
		? lista.map(p => `<li>
			<span class="marca">${p.telefono ? '✆' : ''}</span>
			<span><b>${escapar(p.nombre)}</b> <span class="dato">· DNI ${p.dni}${p.obra_social ? ` · ${escapar([p.obra_social, p.plan].filter(Boolean).join(' '))}` : ''}</span></span>
			<span class="dato tel">${p.telefono_visible || 'Sin teléfono'}</span>
			<button type="button" class="ver editar" data-dni="${p.dni}">Editar</button>
			${p.notas ? `<span class="notas">${escapar(p.notas)}</span>` : ''}
		</li>`).join('')
		: `<li class="vacio-li"><p class="vacio">${todos.length ? 'No hay pacientes que coincidan.' : 'Todavía no hay pacientes. Se guardan solos al facturar, o podés cargarlos acá.'}</p></li>`;
}

function abrirFicha(p) {
	editando = p ? p.dni : null;
	ficha.dni.value = p ? p.dni : '';
	ficha.dni.readOnly = !!p;
	ficha.nombre.value = p?.nombre || '';
	ficha.telefono.value = p?.telefono_visible || '';
	ficha.notas.value = p?.notas || '';
	ficha.obra_social.value = p?.obra_social || '';
	ficha.plan.value = p?.plan || '';
	ficha.numero_socio.value = p?.numero_socio || '';
	$('#ficha-titulo').textContent = p ? p.nombre : 'Nuevo paciente';
	$('#borrar-paciente').hidden = !p;
	$('#confirmar-borrado').hidden = true;
	$('#ficha-error').hidden = true;
	$$('input, textarea', ficha).forEach(i => i.removeAttribute('aria-invalid'));
	ficha.hidden = false;
	$('#lista-pacientes').hidden = true;
	$('.barra').hidden = true;
	(p ? ficha.telefono : ficha.dni).focus();
}

function cerrarFicha() {
	ficha.hidden = true;
	$('#lista-pacientes').hidden = false;
	$('.barra').hidden = false;
	pintarPacientes();
}

function errorFicha(texto) {
	$('#ficha-error').textContent = texto;
	$('#ficha-error').hidden = !texto;
}

$('#nuevo-paciente').addEventListener('click', () => abrirFicha(null));
$('#cancelar-ficha').addEventListener('click', cerrarFicha);
$('#buscar-paciente').addEventListener('input', pintarPacientes);
$('#lista-pacientes').addEventListener('click', e => {
	const boton = e.target.closest('.editar');
	if (boton) abrirFicha(pacientes.get(boton.dataset.dni));
});

ficha.addEventListener('input', e => e.target.removeAttribute('aria-invalid'));

ficha.addEventListener('submit', async e => {
	e.preventDefault();
	const dni = ficha.dni.value.replace(/\D/g, '');
	if (marcar(ficha.dni, !/^\d{6,8}$/.test(dni))) return errorFicha('El DNI debe tener entre 6 y 8 números.');
	if (marcar(ficha.nombre, ficha.nombre.value.trim().length < 2)) return errorFicha('Escribí el nombre y apellido.');
	if (!editando && pacientes.has(dni)) return errorFicha(`Ya hay un paciente con ese DNI: ${pacientes.get(dni).nombre}.`);
	$('#guardar-paciente').disabled = true;
	try {
		await api(`/api/pacientes/${dni}`, {
			method: 'PUT',
			body: JSON.stringify({
				nombre: ficha.nombre.value, telefono: ficha.telefono.value, notas: ficha.notas.value,
				obra_social: ficha.obra_social.value, plan: ficha.plan.value, numero_socio: ficha.numero_socio.value,
			}),
		});
		await cargarPacientes();
		cerrarFicha();
	} catch (err) {
		if (/teléfono|número|cifras/i.test(err.message)) marcar(ficha.telefono, true);
		errorFicha(err.message);
	} finally {
		$('#guardar-paciente').disabled = false;
	}
});

$('#borrar-paciente').addEventListener('click', () => { $('#confirmar-borrado').hidden = false; });
$('#no-borrar').addEventListener('click', () => { $('#confirmar-borrado').hidden = true; });
$('#si-borrar').addEventListener('click', async () => {
	try {
		await api(`/api/pacientes/${editando}`, { method: 'DELETE' });
		await cargarPacientes();
		cerrarFicha();
	} catch (err) {
		errorFicha(err.message);
	}
});

let cuenta = {};

function aplicarCuenta(datos) {
	cuenta = datos;
	document.title = datos.app || 'Facturación';
	$('#nombre-app').textContent = datos.app || 'Facturación';
	$('#emisor').textContent = [datos.nombre, datos.titulo].filter(Boolean).join(' · ') || 'Completá tus datos en Cuenta';
	$('#usuario-top').textContent = datos.usuario;
	simulacion = !!datos.simulacion;
	const aviso = simulacion ? 'Simulación local para desarrollo: nada se envía a ARCA.' : '';
	$('#aviso').textContent = aviso;
	$('#aviso').hidden = !aviso;
	const falta = datos.faltantes || [];
	$('#pendiente').innerHTML = falta.length
		? `Para empezar a facturar completá en <button type="button" class="enlace ir-cuenta">Cuenta</button>: ${escapar(new Intl.ListFormat('es').format(falta))}.`
		: '';
	$('#pendiente').hidden = !falta.length;
	const dias = diasParaVencer(datos);
	$('#vence-certificado').innerHTML = dias !== null && dias > 0 && dias <= 30
		? `Tu certificado de ARCA vence en ${plural(dias, 'día', 'días')}. Después de esa fecha no vas a poder facturar: renovalo desde <button type="button" class="enlace ir-arca">Cuenta → Conexión con ARCA</button>.`
		: '';
	$('#vence-certificado').hidden = !$('#vence-certificado').innerHTML;
}

function diasParaVencer(c) {
	const vence = c.arca?.certificado?.vence;
	if (!vence || c.simulacion) return null;
	return Math.ceil((Date.parse(vence) - Date.now()) / 86_400_000);
}

document.addEventListener('click', e => {
	if (!e.target.closest('.ir-arca')) return;
	mostrarVista('cuenta');
	abrirPanel('arca');
});

document.addEventListener('click', e => {
	if (!e.target.closest('.ir-cuenta')) return;
	mostrarVista('cuenta');
	abrirPanel(cuenta.faltantes?.length === 1 && cuenta.faltantes[0].includes('certificado') ? 'arca' : 'datos');
});

function abrirPanel(nombre) {
	$('#menu-cuenta').hidden = !!nombre;
	$$('#vista-cuenta .panel').forEach(p => { p.hidden = p.dataset.panel !== nombre; });
	$$('#vista-cuenta .estado-form').forEach(p => { p.hidden = true; });
	window.scrollTo({ top: 0 });
}

$$('[data-abrir]').forEach(b => b.addEventListener('click', () => abrirPanel(b.dataset.abrir)));
$$('.volver-cuenta').forEach(b => b.addEventListener('click', () => { pintarResumenCuenta(); abrirPanel(null); }));

function pintarResumenCuenta() {
	const c = cuenta;
	const cuit = c.cuit ? `CUIT ${c.cuit.slice(0, 2)}-${c.cuit.slice(2, 10)}-${c.cuit.slice(10)}` : '';
	$('#resumen-datos').textContent = c.nombre && c.cuit ? `${c.nombre} · ${cuit} · Punto de venta ${c.punto_venta}` : 'Falta completar';
	const cert = c.arca?.certificado;
	const dias = diasParaVencer(c);
	$('#resumen-arca').textContent = !cert
		? 'Falta conectar: sin esto no se puede facturar'
		: dias !== null && dias <= 0
			? `El certificado venció el ${new Date(cert.vence).toLocaleDateString('es-AR')}: renovalo para seguir facturando`
			: dias !== null && dias <= 30
				? `El certificado vence en ${plural(dias, 'día', 'días')}: renovalo`
				: `Conectada · certificado hasta el ${new Date(cert.vence).toLocaleDateString('es-AR')}`;
	const mensaje = (c.mensaje_whatsapp || '').replace(/\s+/g, ' ');
	$('#resumen-whatsapp').textContent = mensaje.length > 70 ? `${mensaje.slice(0, 70)}…` : mensaje;
	$('#resumen-clave').textContent = `Usuario: ${c.usuario}`;
	$$('.menu-cuenta [data-abrir]').forEach(b => {
		const pendiente = (b.dataset.abrir === 'datos' && !(c.nombre && c.cuit)) || (b.dataset.abrir === 'arca' && !c.simulacion && (!cert || (dias !== null && dias <= 30)));
		b.classList.toggle('pendiente', pendiente);
	});
}

function estado(formulario, texto, ok) {
	const p = formulario.querySelector('.estado-form') || formulario;
	p.textContent = texto;
	p.classList.toggle('ok', !!ok);
	p.hidden = !texto;
}

const formDatos = $('#form-datos');
const formWhatsApp = $('#form-whatsapp');
const formClave = $('#form-clave');

function pintarCuenta() {
	const c = cuenta;
	for (const campo of ['nombre', 'titulo', 'domicilio', 'iibb', 'inicio_actividades', 'descripcion']) formDatos[campo].value = c[campo] || '';
	formDatos.cuit.value = c.cuit ? `${c.cuit.slice(0, 2)}-${c.cuit.slice(2, 10)}-${c.cuit.slice(10)}` : '';
	formDatos.punto_venta.value = c.punto_venta || 1;
	pintarArca();
	formWhatsApp.mensaje.value = c.mensaje_whatsapp || '';
	pintarVistaPrevia();
	$('#usuario-actual').textContent = `Usuario: ${c.usuario}`;
	pintarResumenCuenta();
}

function pintarArca() {
	const c = cuenta;
	const cert = c.arca?.certificado;
	$('#arca-estado').textContent = cert
		? 'Conectada. Las facturas se emiten en ARCA y tienen validez fiscal.'
		: 'Se hace una sola vez. Sin el certificado no se puede facturar.';
	$('#descargar-pedido').textContent = c.arca?.tiene_pedido ? 'Descargar pedido otra vez' : 'Descargar pedido';
	$('#regenerar-pedido').hidden = !c.arca?.tiene_pedido;
	$('#paso-pedido').classList.toggle('hecho', !!c.arca?.tiene_pedido);
	$('#paso-certificado').classList.toggle('hecho', !!cert);
	$('#certificado-estado').textContent = cert
		? `Certificado cargado${cert.cuit ? ` del CUIT ${cert.cuit}` : ''}. Vence el ${new Date(cert.vence).toLocaleDateString('es-AR')}.`
		: c.arca?.tiene_pedido ? 'Todavía no subiste el certificado que te dio ARCA.' : 'Primero descargá el pedido (paso 1).';
}

formDatos.addEventListener('submit', async e => {
	e.preventDefault();
	const boton = formDatos.querySelector('[type=submit]');
	boton.disabled = true;
	try {
		const datos = {
			nombre: formDatos.nombre.value, titulo: formDatos.titulo.value, cuit: formDatos.cuit.value,
			domicilio: formDatos.domicilio.value, iibb: formDatos.iibb.value, inicio_actividades: formDatos.inicio_actividades.value,
			punto_venta: parseInt(formDatos.punto_venta.value, 10),
			descripcion: formDatos.descripcion.value,
		};
		let guardada;
		try {
			guardada = await api('/api/cuenta', { method: 'PUT', body: JSON.stringify(datos) });
		} catch (err) {
			if (err.datos?.confirmar !== 'quitar_certificado') throw err;
			if (!confirm(`${err.message}\n\n¿Cambiar el CUIT y quitar el certificado?`)) {
				estado(formDatos, 'No se guardaron los cambios.');
				return;
			}
			guardada = await api('/api/cuenta', { method: 'PUT', body: JSON.stringify({ ...datos, quitar_certificado: true }) });
		}
		aplicarCuenta({ ...cuenta, ...guardada });
		pintarCuenta();
		estado(formDatos, 'Datos guardados.', true);
		if (!leerBorrador()?.descripcion) tanda.descripcion = cuenta.descripcion;
	} catch (err) {
		estado(formDatos, err.message);
	} finally {
		boton.disabled = false;
	}
});

function descargarTexto(nombre, texto) {
	const url = URL.createObjectURL(new Blob([texto], { type: 'application/pkcs10' }));
	const a = Object.assign(document.createElement('a'), { href: url, download: nombre });
	document.body.append(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function pedirCertificado(forzar) {
	const estadoArca = $('#estado-arca');
	try {
		const r = await api('/api/cuenta/pedido', { method: 'POST', body: JSON.stringify({ forzar }) });
		descargarTexto(`pedido-${cuenta.cuit || 'certificado'}.csr`, r.pedido);
		aplicarCuenta(await api('/api/cuenta'));
		pintarArca();
		estado(estadoArca, r.nuevo ? 'Pedido generado y descargado. Ahora subilo en ARCA (paso 2).' : 'Pedido descargado.', true);
	} catch (err) {
		estado(estadoArca, err.message);
	}
}

$('#descargar-pedido').addEventListener('click', () => pedirCertificado(false));
$('#regenerar-pedido').addEventListener('click', () => {
	const aviso = cuenta.arca?.certificado
		? 'Si generás un pedido nuevo, el certificado actual deja de servir y no vas a poder facturar hasta subir el nuevo. ¿Seguir?'
		: 'Se genera una clave nueva. Si ya subiste el pedido anterior a ARCA, vas a tener que subir este. ¿Seguir?';
	if (confirm(aviso)) pedirCertificado(true);
});

$('#archivo-certificado').addEventListener('change', async e => {
	const archivo = e.target.files[0];
	e.target.value = '';
	if (!archivo) return;
	const estadoArca = $('#estado-arca');
	try {
		const contenido = new Uint8Array(await archivo.arrayBuffer());
		let binario = '';
		for (const b of contenido) binario += String.fromCharCode(b);
		aplicarCuenta({ ...cuenta, ...(await api('/api/cuenta/certificado', { method: 'POST', body: JSON.stringify({ archivo: btoa(binario) }) })) });
		pintarArca();
		estado(estadoArca, 'Certificado cargado. Ya podés facturar.', true);
	} catch (err) {
		estado(estadoArca, err.message);
	}
});

function pintarVistaPrevia() {
	const ejemplo = { nombre: 'Ana Pérez', desde: mesDe(-1).desde, hasta: mesDe(-1).hasta, total: 100000, enlace: '/f/123-ejemplo' };
	$('#vista-previa').textContent = mensajeDe(formWhatsApp.mensaje.value, ejemplo);
}

formWhatsApp.mensaje.addEventListener('input', pintarVistaPrevia);

$$('[data-variable]').forEach(b => b.addEventListener('click', () => {
	const area = formWhatsApp.mensaje;
	const inicio = area.selectionStart ?? area.value.length;
	const fin = area.selectionEnd ?? area.value.length;
	area.value = area.value.slice(0, inicio) + b.dataset.variable + area.value.slice(fin);
	area.focus();
	area.selectionStart = area.selectionEnd = inicio + b.dataset.variable.length;
	pintarVistaPrevia();
}));

formWhatsApp.addEventListener('submit', async e => {
	e.preventDefault();
	try {
		aplicarCuenta({ ...cuenta, ...(await api('/api/cuenta/whatsapp', { method: 'PUT', body: JSON.stringify({ mensaje: formWhatsApp.mensaje.value }) })) });
		pintarCuenta();
		estado(formWhatsApp, 'Mensaje guardado.', true);
	} catch (err) {
		estado(formWhatsApp, err.message);
	}
});

formClave.addEventListener('submit', async e => {
	e.preventDefault();
	if (formClave.nueva.value.length < 10) return estado(formClave, 'La nueva tiene que tener al menos 10 caracteres.');
	if (formClave.nueva.value !== formClave.repetida.value) return estado(formClave, 'Las contraseñas nuevas no coinciden.');
	try {
		await api('/api/cuenta/clave', { method: 'PUT', body: JSON.stringify({ actual: formClave.actual.value, nueva: formClave.nueva.value }) });
		formClave.reset();
		estado(formClave, 'Contraseña cambiada. Se cerraron las otras sesiones.', true);
	} catch (err) {
		estado(formClave, err.message);
	}
});

async function iniciar() {
	let datos;
	try { datos = await api('/api/cuenta'); } catch { return; }
	BORRADOR = `facturacion:borrador:${datos.usuario}`;
	aplicarCuenta(datos);

	const b = leerBorrador();
	if (b) {
		Object.assign(tanda, {
			periodo: b.periodo || tanda.periodo, desde: b.desde || '', hasta: b.hasta || '',
			precio: b.precio || '', vto: b.vto && b.vto >= tanda.fecha ? b.vto : tanda.fecha, descripcion: b.descripcion || '',
		});
		// El borrador sale de localStorage: se normaliza antes de usarlo en el HTML.
		const limpio = i => ({
			dni: String(i?.dni ?? '').replace(/\D/g, ''),
			nombre: String(i?.nombre ?? ''),
			sesiones: Math.min(100, Math.max(1, parseInt(i?.sesiones, 10) || 1)),
		});
		const lista = l => (Array.isArray(l) ? l : []).map(limpio).filter(i => i.dni);
		tanda.sel = new Map(lista(b.sel).map(i => [i.dni, i]));
		tanda.extras = new Map(lista(b.extras).map(({ dni, nombre }) => [dni, { dni, nombre }]));
	}
	if (!tanda.descripcion) tanda.descripcion = datos.descripcion || 'Sesión de psicoterapia';
	irAPaso(1);
	cargarPacientes();
	cargarUltimaTanda();
	if (datos.faltantes?.length && !tanda.sel.size) {
		mostrarVista('cuenta');
		abrirPanel('datos');
	}
}

iniciar();
