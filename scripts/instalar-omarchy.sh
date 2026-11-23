#!/usr/bin/env bash
# Compila Vexor y lo instala como paquete de Arch/Omarchy (archivo .pkg.tar.zst).
#
#   ./scripts/instalar-omarchy.sh               compila y instala
#   ./scripts/instalar-omarchy.sh --compilar    solo genera el paquete, sin instalarlo
#   ./scripts/instalar-omarchy.sh --desinstalar quita Vexor del sistema
#   ./scripts/instalar-omarchy.sh --ayuda
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCH_DIR="$ROOT/packaging/arch"
modo="instalar"

azul()  { printf '\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
verde() { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
falla() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --compilar) modo="compilar" ;;
    --desinstalar) modo="desinstalar" ;;
    -h|--ayuda|--help) sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) falla "Opción desconocida: $arg (usa --ayuda)" ;;
  esac
done

[[ $EUID -ne 0 ]] || falla "No lo ejecutes como root ni con sudo: makepkg no lo permite. El script pedirá sudo solo cuando haga falta."
command -v pacman >/dev/null || falla "Este script es para Arch Linux / Omarchy (no encuentro pacman)."

if [[ $modo == "desinstalar" ]]; then
  azul "Desinstalando Vexor"
  sudo pacman -Rns vexor
  verde "Vexor desinstalado. Tu configuración sigue en ~/.config/vexor (bórrala a mano si quieres)."
  exit 0
fi

azul "1/4 Instalando dependencias"
paquetes=(webkit2gtk-4.1 gtk3 libsoup3 base-devel nodejs npm git)
# Si ya tienes Rust (rustup o el paquete), no se instala otro encima.
command -v cargo >/dev/null || paquetes+=(rust)
sudo pacman -S --needed --noconfirm "${paquetes[@]}"
command -v cargo >/dev/null || falla "No encuentro cargo. Si usas rustup, ejecuta: rustup default stable"

azul "2/4 Preparando el paquete"
version="$(node -p "require('$ROOT/package.json').version")"
sed -i "s/^pkgver=.*/pkgver=$version/" "$ARCH_DIR/PKGBUILD"
cd "$ARCH_DIR"
rm -f vexor-*.pkg.tar.*
rm -rf src pkg
verde "Versión $version"

azul "3/4 Compilando (la primera vez tarda varios minutos)"
# -d: las dependencias ya las instaló el paso 1 (así no choca con rustup); -f: rehacer si ya existía.
makepkg -f -d

paquete="$(ls -t "$ARCH_DIR"/vexor-*.pkg.tar.zst 2>/dev/null | head -1 || true)"
[[ -n "$paquete" ]] || falla "No se generó el paquete .pkg.tar.zst."
verde "Paquete generado: $paquete"

if [[ $modo == "compilar" ]]; then
  echo "Para instalarlo después: sudo pacman -U \"$paquete\""
  exit 0
fi

azul "4/4 Instalando"
sudo pacman -U --noconfirm "$paquete"
verde "Vexor $version instalado. Ábrelo desde el menú de aplicaciones o ejecutando: vexor"
echo "Para quitarlo: ./scripts/instalar-omarchy.sh --desinstalar"
