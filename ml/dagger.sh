#!/usr/bin/env bash
# DAgger loop: net drives, bot corrects, aggregate + retrain, measure. Fixes the
# compounding-error collapse of plain imitation. Run from the repo root:
#   bash ml/dagger.sh 2>&1 | tee ml/dagger.log
set -e
V="cross:40,rune:10,draugr:0"          # the measurable (winnable) variant
DATA="ml/data/norm ml/data/win"        # base imitation dataset (D0)
GAMES=1000
ROUNDS=${1:-4}

echo "=== round 0 (base imitation net) ==="
node ml/play_net.mjs --games $GAMES --tiles $V

for i in $(seq 1 $ROUNDS); do
  echo "=== DAgger round $i: collect net-driven, bot-labelled states ==="
  node ml/dagger_gen.mjs --games $GAMES --model ml/model.onnx --tiles $V --seed $((500000 + i * 100000)) --out ml/data/dag$i
  DATA="$DATA ml/data/dag$i"
  echo "--- retrain on aggregate ($DATA) ---"
  py ml/train.py --data $DATA --out ml/model --epochs 10 2>&1 | tail -1
  echo "--- measure round $i net ---"
  node ml/play_net.mjs --games $GAMES --tiles $V
done
echo "=== DAgger complete ==="
