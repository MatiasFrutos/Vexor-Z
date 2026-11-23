# Cambios

Historial de versiones de Vexor (las más recientes primero).

## 0.6.1 (rendimiento)
- Las ventanas (Ajustes, paleta, ayuda, diálogos) ya no desenfocan el fondo: dibujar un fotograma con Ajustes abierto pasó de ~128 ms a ~49 ms en las mediciones. Animaciones de apertura más cortas.
- La rama de git ya no se consulta cada 1,5 s (dos procesos `git` cada vez): ahora al cambiar de carpeta, al terminar un comando o cada 6 s.
- La barra de estado solo se redibuja cuando cambia algo; la terminal solo usa transparencia cuando hay fondo u opacidad; animación de inicio más corta (~0,6 s).

## 0.6
- **Aspecto futurista (HUD)**: esquinas en ángulo, rótulos técnicos, marcas en las esquinas del panel activo, animación de inicio y tres temas nuevos (**Vexor Cyber**, **Synthwave**, **Ámbar**). Sin resplandor por defecto; se activa en Ajustes → Interfaz. El aspecto anterior sigue disponible (Estilo: *Limpio*).
- **Cliente HTTP** (`Ctrl+Alt+A`): prueba APIs sin salir de la terminal (método, cabeceras, cuerpo, respuesta con JSON formateado, recientes, copiar como `curl`).
- **Resumen del sistema**: gráfica de CPU, memoria, red (↓/↑), tiempo encendido y discos.
- **Copiar la salida del último comando** (`Ctrl+Shift+X`), **carpetas favoritas** (estrella en Archivos y «Favorito: …» en la paleta) y **snippets con variables** (`{{nombre}}` pide el valor).
- Aviso en el selector cuando suena una campana o termina un comando en otro espacio de trabajo; reloj en la barra de estado.
- **Correcciones**: las marcas verde/roja de cada comando se apilaban arriba en vez de ir junto a su comando; al terminar un proceso en otro espacio de trabajo se cerraba una pestaña equivocada; el Enter de confirmar un diálogo o la paleta se colaba en la terminal y ejecutaba el comando insertado.


## 0.5
- **Espacios de trabajo**: grupos de pestañas (p. ej. *Backend*, *Servidores*, *Ocio*) con su propio color; cambia con `Ctrl+Alt+1…9`, muévelos entre sí desde el menú de la pestaña. Los procesos de los otros espacios siguen vivos y todo se restaura al abrir.
- **Pestañas arriba o en barra lateral** (Ajustes → Interfaz), menú contextual de pestañas (renombrar, duplicar, mover, cerrar otras).
- **Tamaño de la interfaz ajustable** del 75 % al 160 % (`Ctrl+Alt+=` / `−` / `0`, con vista previa en vivo), tamaño de ventana recordado, modo zen (`Ctrl+Shift+Enter`), pantalla completa (`F11`).
- **Panel lateral con 9 herramientas**: IA · Git · **Archivos** · **Tareas** (package.json, Cargo, Makefile, justfile, compose) · Docker · **Sistema** (procesos y puertos, con terminar/matar) · Snippets · **Notas** · Herramientas.
- **Buscador de historial de comandos** (`Ctrl+Shift+R`): bash, zsh y fish; ve incluso los comandos de las sesiones abiertas.
- Ventanas, menús y Ajustes rediseñados (navegación lateral, más limpios).
- **Corrección importante**: si Vexor se lanzaba sin un locale UTF-8 en el entorno, bash descartaba la `ñ`, las tildes y la `ü` al teclearlas. Ahora se fuerza UTF-8.
