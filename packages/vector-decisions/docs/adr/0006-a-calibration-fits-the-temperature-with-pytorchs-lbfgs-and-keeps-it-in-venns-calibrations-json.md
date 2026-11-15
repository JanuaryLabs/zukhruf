# A calibration fits the temperature with PyTorch's LBFGS, and keeps it in Venn's calibrations.json

Status: Proposed (2026-11-14). Amended 2026-11-15: the clamp (decision 8) and the registry file (decision 4).

## Context

Venn's `register_calibration` (`venn/server.py:465`) fits one softmax temperature to labelled logits for each family and type of question. `decide` then divides the logits of those questions by that temperature, not by `choice_temperature` (`venn/server.py:803-805`). The fit is `fit_temperature` (`venn/heads/calibration.py`): one step of `torch.optim.LBFGS` with the strong Wolfe line search and at most 100 iterations, on the logarithm of the temperature, clamped to [−5, 5]. The other options stay at the defaults of PyTorch, so the step stops when the loss changes by less than 1e-9.

ADR 0001 planned the fit on the L-BFGS-B of SciPy, which mteb ports, in a package of its own. Venn has no SciPy. A probe on 2026-11-14 compared both with Venn's temperatures for 71 sets of logits:

| Optimizer                                                   | Within 1e-9 of Venn | Largest difference                    |
| ----------------------------------------------------------- | ------------------- | ------------------------------------- |
| SciPy's L-BFGS-B with its defaults                          | 22                  | 5.7e-4, and 68% on a flat loss        |
| SciPy's L-BFGS-B to the minimum of the loss                 | 4                   | 9.2e-5, and 44% on a flat loss        |
| A port of PyTorch's LBFGS with the strong Wolfe line search | 70                  | 1.8e-5, for one set with a flat start |

PyTorch stops before the minimum, so the minimum is not Venn's temperature. Only the steps of PyTorch's line search give it.

## Decision

1. `LBFGS` (`src/gradients/lbfgs.ts`) is one step of `torch.optim.LBFGS` of PyTorch 2.15.0 with `line_search_fn="strong_wolfe"`, from a new optimizer: the two-loop recursion, `_strong_wolfe` and `_cubic_interpolate`, with PyTorch's stops. It lives beside AdamW, for the reason of ADR 0002. It takes `maxIter`, the one option that Venn sets.
2. `TemperatureScaling.fit` gives the loss of `CrossEntropyLoss` (`src/gradients`) for the logits divided by e^clamp(log T), and its gradient to log T. The clamp passes the gradient of log T clamped, also outside [−5, 5] (decision 8).
3. `registerCalibration(family, logits, targets, kind = 'Choice')` checks in Venn's order. Fewer than 200 or more than 10,000 rows, or another count of targets, give `calibration_size`. Then a logit that is not finite in float32, or a target that is not a whole number from 0 to the count of columns, gives `calibration_labels`. The logits are rounded to float32 before the fit, as Venn rounds them. Rows of different lengths also give `calibration_size`. Venn raises a `ValueError` for them, so that code is mine.
4. `DecisionService.load` takes `registryPath`, the file of the temperatures, as Venn's `registry_path` is a file (`venn/server.py:91`). `load` makes its directory. The file is in Venn's format: `json.dumps(calibrations, indent=2)` and a new line, with keys `"<family>/<type>"` in the order of their first registration. `load` reads the file when it exists, so a registry that Venn wrote works. Each change writes the file again, synchronously, so two changes never write at the same time, and `decide` uses the change only after the write. Venn changes its map first (`venn/server.py:476-477`), so after a failed write its `decide` uses a temperature that the file does not have, and a restart loses it. `load` refuses a file that is not JSON, not an object, or holds a temperature that is not a positive finite number, with a `TypeError` that names the file: `decide` divides by each temperature. Venn reads any JSON.
5. `kind` is `Choice`, `Score` or `Noul`: the types whose temperature `decide` reads. IndexApply reads the temperature of Choice. Venn takes any string, and stores a temperature that no question reads.
6. A question takes the family that it names, else the family of the request, else `""`. A `questionRef` takes the family of the registered question.
7. A Noul question divides its "none" part by its temperature and its options by `choice_temperature` (ADR 0003). An answer stays `calibrated: false`: Venn sets `true` only for the head of a family (U10, U13).
8. Venn's clamp is a defect, and the port does not keep it (Ezz, 2026-11-15: "Fix: pass-through clamp"). `log_t.clamp(-5, 5)` (`venn/heads/calibration.py:19`, venn-vdm 7b2042e) passes a gradient of 0 outside [−5, 5]. When a step of the line search goes past −5, the fit sees a flat loss with a gradient of 0, takes the step (a slope of 0 meets the strong Wolfe curvature condition), and stops: Venn returns e^-5 although the best temperature is inside the bounds. In a probe of 1,500 sets of small logits (scaled by 0.01 to 0.5), 250 stopped at e^-5. In the worst set, the loss is 0.97 at e^-5 and 0.31 at the best temperature (0.0359, which a grid of log T finds within 3e-6). The port passes the gradient of log T clamped (a straight-through clamp). The loss still reads log T clamped, so nothing overflows, and the result is clamped. On the 21 sets of the fixture, this gives Venn's temperatures bit for bit. scikit-learn 1.8 (`_TemperatureScaling`) avoids the flat loss another way, with a bounded scalar search on log β in (−10, 10). That would lose the steps of PyTorch, and so Venn's temperatures.

## Consequences

- The fit gives Venn's temperatures within 9.1e-11 on the 21 sets of the fixture. On a flat loss, two losses can differ by less than their rounding. Then the line search can take another branch, and the temperature differs from Venn's (1 of 92 measured sets, by 1.8e-5).
- This ADR supersedes the consequence of ADR 0001 "The optimizer that linear Choice and calibration need moves out of mteb into its own package". Venn has no SciPy, so the L-BFGS-B stays in mteb, and no package `@zukhruf/optimize` exists. U10 also fits with `torch.optim.LBFGS` (`venn/heads/linear_choice.py:28`), so U10 adds the options that it sets to `LBFGS`.
- `src/gradients/lbfgs.test.ts` compares `LBFGS` with `torch.optim.LBFGS` step by step: the parameter values at each call of the closure, on nine analytic cases that reach each branch of the line search and the stops, a 2-D Rosenbrock and a case of two parameters among them (`fixtures/generate_lbfgs.py`). The calibration fit alone shows only the final temperature within 1e-9, so it does not see a step that changes. Only the cap of 100 corrections is not reached; U10 sets 20.
- A crash during a write can leave part of the file, as in Venn. Then `load` throws a `TypeError` that names the file.
- For the same logits, the port's temperature differs from Venn's only where Venn's fit stops at e^-5 by mistake. The fixture holds one such set ("past the bound"). `generate.py` takes its temperature from Venn's `fit_temperature` with the clamp that passes the gradient, and checks that this fit equals Venn's on every other set.
- The upper bound: in 2,000 sets of large logits, whose best log T was above 3.5 for 1,666 of them, 1,091 fits of Venn stepped past +5, and none stopped at a temperature other than the one that the fix finds. So no test pins the clamp at +5; the same expression passes the gradient at both bounds.
- venn-1's own logits are the cosines divided by its temperature 0.067, and its `choice_temperature` is 1.05, so a calibration of its logits fits a temperature near 1, far from the bounds.
