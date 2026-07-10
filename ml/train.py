"""
Mirkwood ML — Phase 1: imitation trainer.

Distils the heuristic bot's MOVEMENT policy into a small MLP (policy head over
[N,E,S,W,stay] + a win-probability value head), then exports ONNX that runs
unchanged in Node / the browser / the Worker.

  py ml/train.py --data ml/data/norm ml/data/win --out ml/model --epochs 12
  py ml/train.py --data ml/data/win --device dml           # use the 7900XTX (DirectML)

Reads the packed binaries written by ml/gen_data.mjs. CPU by default (the net is
tiny); --device dml routes to the AMD GPU via torch-directml.
"""
import argparse, json, time
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ap = argparse.ArgumentParser()
ap.add_argument('--data', nargs='+', required=True, help='one or more gen_data prefixes')
ap.add_argument('--out', default='ml/model')
ap.add_argument('--epochs', type=int, default=12)
ap.add_argument('--batch', type=int, default=4096)
ap.add_argument('--lr', type=float, default=1e-3)
ap.add_argument('--hidden', type=int, default=512)
ap.add_argument('--vweight', type=float, default=0.5, help='value-loss weight')
ap.add_argument('--device', default='cpu', choices=['cpu', 'dml', 'cuda'])
args = ap.parse_args()

# ---- device ----
if args.device == 'dml':
    import torch_directml
    dev = torch_directml.device()
    print('device: DirectML (', torch_directml.device_name(0), ')')
elif args.device == 'cuda':
    dev = torch.device('cuda'); print('device: CUDA')
else:
    dev = torch.device('cpu'); print('device: CPU')

# ---- load data (concatenate all prefixes) ----
xs, ys, F_LEN = [], [], None
for pfx in args.data:
    meta = json.load(open(pfx + '.meta.json'))
    F_LEN = meta['featureLen']
    x = np.fromfile(pfx + '.x.f32', dtype=np.float32).reshape(-1, F_LEN)
    y = np.fromfile(pfx + '.y.u8', dtype=np.uint8).reshape(-1, 8)
    assert x.shape[0] == y.shape[0], f'{pfx}: x/y row mismatch'
    xs.append(x); ys.append(y)
    print(f'loaded {pfx}: {x.shape[0]} samples (bot win {meta.get("botWinRate")}%)')
X = np.concatenate(xs); Y = np.concatenate(ys)
N = X.shape[0]
print(f'total {N} samples, {F_LEN} features')

legal = torch.from_numpy(Y[:, 0:5].astype(np.float32))
chosen = torch.from_numpy(Y[:, 5].astype(np.int64))
value = torch.from_numpy(Y[:, 6].astype(np.float32))
Xt = torch.from_numpy(X)

# ---- train/val split ----
g = torch.Generator().manual_seed(0)
perm = torch.randperm(N, generator=g)
nval = max(1, N // 20)
vi, ti = perm[:nval], perm[nval:]

# ---- model ----
class Net(nn.Module):
    def __init__(self, fin, h):
        super().__init__()
        self.body = nn.Sequential(nn.Linear(fin, h), nn.ReLU(), nn.Linear(h, h), nn.ReLU(), nn.Linear(h, h // 2), nn.ReLU())
        self.pi = nn.Linear(h // 2, 5)     # policy logits over [N,E,S,W,stay]
        self.v = nn.Linear(h // 2, 1)      # win-probability logit

    def forward(self, x):
        z = self.body(x)
        return self.pi(z), self.v(z)

net = Net(F_LEN, args.hidden).to(dev)
opt = torch.optim.Adam(net.parameters(), lr=args.lr)
NEG = -1e9

def batches(idx, bs, shuffle=True):
    if shuffle:
        idx = idx[torch.randperm(idx.numel())]
    for i in range(0, idx.numel(), bs):
        yield idx[i:i + bs]

def run_epoch(idx, train):
    net.train(train)
    tot = pcorrect = vcorrect = seen = 0
    for b in batches(idx, args.batch, shuffle=train):
        xb = Xt[b].to(dev); lb = legal[b].to(dev); cb = chosen[b].to(dev); vb = value[b].to(dev)
        pi, v = net(xb)
        pim = pi + (lb - 1) * 1e9              # mask illegal moves
        ploss = F.cross_entropy(pim, cb)
        vloss = F.binary_cross_entropy_with_logits(v.squeeze(1), vb)
        loss = ploss + args.vweight * vloss
        if train:
            opt.zero_grad(); loss.backward(); opt.step()
        with torch.no_grad():
            pcorrect += (pim.argmax(1) == cb).sum().item()
            vcorrect += ((v.squeeze(1) > 0) == (vb > 0.5)).sum().item()
            seen += cb.numel(); tot += loss.item() * cb.numel()
    return tot / seen, pcorrect / seen, vcorrect / seen

t0 = time.time()
for ep in range(args.epochs):
    trl, trp, trv = run_epoch(ti, True)
    with torch.no_grad():
        val, vap, vav = run_epoch(vi, False)
    print(f'ep {ep+1:2d}  train loss {trl:.3f} moveAcc {trp:.3f}  |  val loss {val:.3f} moveAcc {vap:.3f} winAcc {vav:.3f}  ({time.time()-t0:.0f}s)')

# ---- export ONNX (runs in Node / browser / Worker) ----
net.eval().cpu()
dummy = torch.zeros(1, F_LEN)
torch.onnx.export(
    net, dummy, args.out + '.onnx',
    input_names=['features'], output_names=['policy', 'value'],
    dynamic_axes={'features': {0: 'batch'}, 'policy': {0: 'batch'}, 'value': {0: 'batch'}},
    opset_version=17,
)
torch.save(net.state_dict(), args.out + '.pt')
json.dump({'featureLen': F_LEN, 'hidden': args.hidden, 'moveActions': ['N', 'E', 'S', 'W', 'stay']},
          open(args.out + '.json', 'w'), indent=2)
print(f'exported {args.out}.onnx  (+ .pt, .json)')
