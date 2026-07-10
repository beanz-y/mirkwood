#!/usr/bin/env bash
# Plan-conditioned DAgger: start from the plan-conditioned net (which CAN represent
# the policy), let it drive, bot-correct on its own trajectories, aggregate, retrain.
# Now that the representation gap is closed, DAgger should actually climb.
#   bash ml/dagger_plan.sh 5 2>&1 | tee ml/dagger_plan.log
set -e
V="cross:40,rune:10,draugr:0"
DATA="ml/data/pwin ml/data/pnorm"
GAMES=1500
ROUNDS=${1:-5}

echo "=== round 0 (plan-conditioned imitation net) ==="
node ml/play_net.mjs --games 1000 --plan --model ml/model_plan.onnx --tiles $V
for i in $(seq 1 $ROUNDS); do
  echo "=== plan-DAgger round $i ==="
  node ml/dagger_gen.mjs --games $GAMES --plan --model ml/model_plan.onnx --tiles $V --seed $((600000 + i * 100000)) --out ml/data/dagP$i
  DATA="$DATA ml/data/dagP$i"
  py ml/train.py --data $DATA --out ml/model_plan --epochs 10 2>&1 | tail -1
  node ml/play_net.mjs --games 1000 --plan --model ml/model_plan.onnx --tiles $V
done
echo "=== plan-DAgger complete ==="
