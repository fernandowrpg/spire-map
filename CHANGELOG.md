# Changelog

Todas as mudanças relevantes deste módulo. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões usam
[SemVer](https://semver.org/lang/pt-BR/).

## [1.1.0] — 2026-08-14

### Adicionado

- **Nós secretos**: as salas nascem ocultas, mostradas aos jogadores como um nó neutro
  com `?`. Rótulos, ícones (Tiles) e notas de mapa das salas ocultas ficam invisíveis
  para eles.
- **Controle de revelação** (`Alt+R` ou botão do olho): minimapa com os tipos reais
  esmaecidos para o Mestre, lista das escolhas disponíveis, estado de cada nó por andar,
  e botões de revelar/ocultar nó, revelar andar, revelar tudo, ocultar não visitados,
  voltar um passo e reiniciar o progresso.
- **Progresso do grupo** guardado na cena (flags `spire-map.map` e `spire-map.progress`):
  sobrevive a recarregar o mundo e sincroniza para todos os clientes.
- Modos de revelação **automático pela escolha** e **manual**, com *passos à frente*
  configurável (0 = descobre ao entrar, 1 = opções imediatas, 2+ = mais adiante).
- Marcador em anel na posição atual do grupo, com cor configurável.
- Opção de esconder também os caminhos até revelar, e de anunciar cada avanço no chat.
- Aba **Segredo** no painel e botão de espião no preview, que mostra exatamente o que os
  jogadores estão vendo.
- API para macros: `openTracker`, `read`, `choose`, `revealNodes`, `revealAll`,
  `hideUnvisited`, `resetProgress`, `resync` e a biblioteca pura `progress`.

### Alterado

- O renderizador SVG passou a aceitar um estado de nevoeiro, usado tanto no preview
  quanto no minimapa do Mestre.
- Revelar é uma atualização em lote da aparência do mesmo desenho — nada é recriado, e
  não existe documento escondido com o tipo real que um jogador possa inspecionar.

## [1.0.0] — 2026-08-14

### Adicionado

- Gerador de mapas no estilo Slay the Spire: caminhos que sobem andar a andar,
  anti-cruzamento geométrico, anti-loop-curto, poda de becos sem saída e sorteio
  ponderado de salas com andar mínimo, limites e regras de repetição.
- Seed determinística: a mesma seed sempre gera o mesmo mapa.
- Painel de configuração com preview ao vivo, presets, editor de tipos de nó
  customizados e sobrescrita manual do tipo de cada nó.
- Desenho na cena ativa ou em uma cena nova, com Drawings para nós e caminhos, Tiles
  para ícones, numeração de andares, título e notas de mapa com entradas de diário
  opcionais.
- Exportação em SVG e exportação/importação da configuração em JSON.
- Interface em português (Brasil) e inglês.
