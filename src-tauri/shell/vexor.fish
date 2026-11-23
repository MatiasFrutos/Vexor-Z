# Integración de shell de Vexor (fish): marcas de prompt OSC 133.
status is-interactive; or exit 0
set -q VEXOR_SHELL_INTEGRATION; and exit 0
set -gx VEXOR_SHELL_INTEGRATION 1
function __vexor_prompt --on-event fish_prompt
    printf '\e]133;D;%s\a\e]133;A\a\e]7;file://%s%s\a' $status $hostname $PWD
end
function __vexor_preexec --on-event fish_preexec
    printf '\e]133;C\a'
end
