# Integración de shell de Vexor (zsh): marcas de prompt OSC 133.
[[ -o interactive ]] || return 0
[[ -n "$VEXOR_SHELL_INTEGRATION" ]] && return 0
export VEXOR_SHELL_INTEGRATION=1
autoload -Uz add-zsh-hook
__vexor_precmd() { local ec=$?; printf '\e]133;D;%s\a\e]133;A\a\e]7;file://%s%s\a' "$ec" "$HOST" "$PWD"; return $ec }
__vexor_preexec() { printf '\e]133;C\a' }
add-zsh-hook precmd __vexor_precmd
add-zsh-hook preexec __vexor_preexec
