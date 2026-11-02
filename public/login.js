const form = document.querySelector('#login');
const error = document.querySelector('#error');
const boton = document.querySelector('#entrar');

form.addEventListener('submit', async e => {
	e.preventDefault();
	const usuario = form.usuario.value.trim();
	const clave = form.clave.value;
	if (!usuario || !clave) {
		const vacio = !usuario ? form.usuario : form.clave;
		vacio.setAttribute('aria-invalid', 'true');
		vacio.focus();
		return;
	}
	boton.disabled = true;
	error.hidden = true;
	try {
		const r = await fetch('/api/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ usuario, clave }),
		});
		if (r.ok) {
			location.replace('/');
			return;
		}
		const datos = await r.json().catch(() => null);
		error.textContent = datos?.detail || 'No se pudo ingresar. Probá de nuevo.';
	} catch {
		error.textContent = 'No hay conexión. Probá de nuevo.';
	}
	error.hidden = false;
	form.clave.value = '';
	form.clave.setAttribute('aria-invalid', 'true');
	form.clave.focus();
	boton.disabled = false;
});

form.addEventListener('input', e => e.target.removeAttribute('aria-invalid'));
