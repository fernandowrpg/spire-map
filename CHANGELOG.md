# Changelog

Todas as mudanças relevantes deste módulo. O formato segue
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e as versões usam
[SemVer](https://semver.org/lang/pt-BR/).

## [1.3.2] — 2026-08-14

### Corrigido

- **O mapa saía descentralizado, deslocado para cima e para a esquerda do retângulo da cena.**
  No Foundry, a origem `(0, 0)` de um documento é o canto do *canvas*, e o canvas inclui a
  margem (padding) da cena — o retângulo visível começa em `(sceneX, sceneY)`. O módulo
  desenhava em `(0, 0)`, ou seja, dentro da margem. Agora o mapa é posicionado a partir do
  retângulo da cena e **centralizado** nele, o que também trata o caso da cena ser maior que
  o mapa (modos *Só aumentar* e *Não mexer*).
- O marcador do grupo e as notas criadas durante a revelação passaram a usar a mesma origem
  do desenho do mapa, que fica guardada na flag da cena.
- O enquadramento inicial aponta para o centro do mapa em coordenadas do canvas, e é gravado
  **depois** do redimensionamento — antes ele era calculado com as dimensões antigas.

### Alterado

- O mock de teste passou a expor `Scene#dimensions` com o deslocamento da margem, como o
  Foundry, e a suíte de pintura mede a caixa ocupada pelos documentos contra o retângulo da
  cena em seis cenários (ajuste exato, cena grande, margem 0, margem 0,4, com notas e ícones,
  cena nova). Com o bug de volta, os testes acusam exatamente o deslocamento visto no jogo.

## [1.3.1] — 2026-08-14

### Corrigido

- **Erro ao trocar de aba no painel**: `You must pass both the tab and tab group identifier`.
  O ApplicationV2 trata `data-action="tab"` internamente (chamando `changeTab(tab, group)`),
  e o módulo usava exatamente esse nome para as próprias abas — o framework executava a ação
  dele por cima da nossa e estourava por falta do grupo.
- Todas as ações do módulo passaram a usar prefixo próprio (`spireTab`, `spireRefresh`,
  `spirePaint`, …), de modo que não há como colidir com as ações internas do ApplicationV2,
  nem com as que o Foundry vier a reservar.
- O mock de teste passou a reproduzir o comportamento do framework para as ações reservadas
  e a exigir o prefixo — o erro relatado é hoje coberto por teste.

## [1.3.0] — 2026-08-14

### Adicionado

- **Tamanho da cena** (aba Saída): a cena ativa passa a ser ajustada ao tamanho exato do
  mapa. Três modos — *Ajustar exatamente ao mapa* (padrão, reduz e aumenta), *Só aumentar
  se for menor* (comportamento até a 1.2.0) e *Não mexer nas dimensões*.
- **Margem da cena** configurável (padrão 0,05; o padrão do Foundry é 0,25), aplicada junto
  com o ajuste exato.
- O **enquadramento inicial** da cena passa a ser gravado, com o centro do mapa e uma escala
  que mostra o mapa inteiro — a cena abre já enquadrada. A câmera do Mestre também é levada
  para o mapa logo depois de desenhar.
- Uma notificação informa as dimensões antes e depois quando a cena é redimensionada.

### Alterado

- A cena nova passou a usar a mesma margem configurável e o mesmo enquadramento do ajuste
  exato, em vez de valores fixos.

## [1.2.0] — 2026-08-14

### Adicionado

- Compatibilidade com **Foundry VTT v14** (verificado na 14.365, "Version 14 Stable 7").
  O módulo continua funcionando no v13 — é um pacote só para as duas versões.

### Corrigido

- **As notas de mapa dos nós ocultos não estavam escondidas.** O documento `Note` não tem
  campo `hidden` no schema do Foundry (nem no v13 nem no v14), então a flag era descartada
  em silêncio e o nome da sala aparecia no canvas para os jogadores. Agora a nota de um nó
  oculto simplesmente não existe: é criada ao revelar e removida ao ocultar.
- As entradas de diário nascem com posse `NONE` para os jogadores, de forma explícita, para
  que não apareçam na barra lateral nem em buscas.
- `compatibility.maximum` estava fixo em `"13"`, o que **bloqueava a instalação no v14**.
  Removido; agora o manifesto declara `minimum: 13` e `verified: 14`.

### Alterado

- Os códigos de forma dos desenhos e os enums de grade, âncora de texto e posse passaram a
  ser lidos de `foundry.data.ShapeData.TYPES` e de `CONST` em tempo de execução, com os
  valores históricos como reserva — o módulo não quebra se uma versão futura mexer nisso.
- `createNotes` e `createJournal` agora são independentes: dá para ter as entradas de diário
  (só do Mestre) sem espalhar pinos pelo mapa.
- O validador (`tools/check-module.mjs`) avisa quando `compatibility.maximum` está definido.

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
