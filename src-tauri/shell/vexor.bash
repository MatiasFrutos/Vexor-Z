# Integración de shell de Vexor (bash): marcas de prompt OSC 133 para saltar entre prompts,
# ver el código de salida y la duración de cada comando, y recibir avisos de comandos largos.
[[ $- == *i* ]] || return 0
[[ -n "$VEXOR_SHELL_INTEGRATION" ]] && return 0
export VEXOR_SHELL_INTEGRATION=1
__vexor_precmd() {
  local ec=$?
  printf '\e]133;D;%s\a\e]133;A\a\e]7;file://%s%s\a' "$ec" "${HOSTNAME}" "${PWD}"
  builtin history -a 2>/dev/null   # el buscador de historial de Vexor ve los comandos de las sesiones abiertas
  return "$ec"
}
PS0=$'\e]133;C\a'"${PS0:-}"
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__vexor_precmd "${PROMPT_COMMAND[@]}")
else
  PROMPT_COMMAND="__vexor_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
