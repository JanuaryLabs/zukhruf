# Write the gradients of the heads by hand, with AdamW as PyTorch computes it

Status: Accepted (2026-11-14).

## Context

Venn trains two kinds of head by gradient descent on frozen vectors: the residual Choice family (`FamilyScorer` in `venn/heads/family.py`) and the outcome heads (`BilinearHead` in `venn/heads/outcome.py`). Both use the autograd of PyTorch and `torch.optim.AdamW`. Units U13 and U14 of this package port these heads, so the package needs gradients and AdamW in TypeScript.

The heads use few modules, and each module has a fixed form: `nn.Linear`, the exact form of `nn.GELU`, a bilinear score of rank 16, attention pooling over the fields of a state, `F.normalize`, and a weighted cross-entropy. The largest network in a head has two layers.

On 2026-11-14, no package on npm was satisfactory:

- TensorFlow.js (`@tensorflow/tfjs` 4.22.0) has autograd, but its tensors have no float64 type. Thus its forward pass cannot give the float64 numbers of PyTorch. Its fast backend for Node (`@tensorflow/tfjs-node`) is a native library. The two packages have no release after 21 October 2024.
- js-pytorch 0.7.2 has autograd, but it has no release after 29 October 2024, and it depends on a GPU package (`@eduardoleao052/gpu`).
- brain.js trains only its own kinds of network. A program cannot make a network from its own modules with it.

## Decision

1. The package writes the forward pass and the backward pass of each module by hand, in `src/gradients/`. It has no autograd.
2. A module computes in float64. A `Matrix` holds its numbers in a row-major `Float64Array`, as a PyTorch tensor of two dimensions does. The forward pass of each module gives the numbers of the float64 forward pass of PyTorch. GELU gets erf from the npm package `cephes`, as `PreparedQuestion` does.
3. A forward pass returns its output and the functions that go back from it:
   - `pullback(gradient)` gives the gradient with respect to the input. It is the vector-Jacobian product, `vjp` in JAX and the pullback of `rrule` in ChainRules.
   - `accumulate(gradient)` adds the gradient of each parameter to `Parameter.gradient`, as `accGradParameters` in Torch7 does.

   The two functions are separate. Thus a caller whose input is data does not compute the gradient of the input, and a caller with frozen parameters does not compute their gradients.

4. A pass gives only the gradients that a head of Venn uses. `LowRankBilinear` gives no gradient of its options, and `AttentionPooling` gives no gradient of its fields or its questions, because these are always data.
5. `CrossEntropyLoss` divides the weighted sum of the losses by the sum of the weights, but by 1e-9 at least, as `fit_outcome_head` does. `family.py` does not clamp the sum, so there a batch whose weights are all 0 gives NaN. Here it gives 0.
6. `CrossEntropyLoss` has no argument for a mask. Venn masks an absent option with the logit −1e4, and in float64 the probability of that logit is 0. Thus the logit adds nothing to the loss, and its gradient is 0.
7. `AdamW` does the steps of `torch.optim.AdamW` of PyTorch 2.15.0, in the order of its single-tensor path, which the CPU uses: first the decay `p ← p · (1 − lr · weight_decay)`, then the Adam step with bias correction. Venn sets only `lr` and `weight_decay`, so only these two are options. The betas (0.9, 0.999) and eps (1e-8) are the defaults of PyTorch. The package does not port amsgrad or maximize.
8. `zeroGrad` sets each gradient to zeros. PyTorch sets each gradient to None, and its step does not change a parameter that has no gradient. In the heads of Venn, each step gives a gradient to each parameter, so the two give the same steps.
9. The modules do not choose start values for their parameters. The unit that trains a head gives them, from the random generator that it uses.

## Consequences

- A trained head can match Venn only in quality, not number for number, because Venn gets its start values from the random generator of PyTorch (ADR 0001, item 6).
- The proof of the modules has three parts. A golden test compares the forward pass of each module with PyTorch in float64 (`src/gradients/fixtures/generate.py`). A central finite-difference check compares each gradient that a module gives with its forward pass. A golden test compares AdamW with `torch.optim.AdamW`. On 2026-11-14, the forward passes were within 6e-16 of PyTorch, and AdamW gave the same parameters as PyTorch, bit for bit.
- A new module needs its own backward pass, a golden test of its forward pass and a finite-difference check.
- The products of `Matrix` are loops in JavaScript, not BLAS. If training is too slow for U13 or U14, a faster product changes only `Matrix`.
