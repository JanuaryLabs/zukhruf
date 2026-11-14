// The output of a forward pass and its pullback: the vector-Jacobian
// product that turns the gradient of the loss with respect to the output into
// its gradient with respect to the input (JAX's vjp, ChainRules' rrule).
export type Differentiable<Output, InputGradient> = {
  readonly output: Output;
  pullback(gradient: Output): InputGradient;
};

// The output of a forward pass of a module with parameters, and the step that
// adds the gradient of each parameter to Parameter.gradient (Torch7's
// accGradParameters). A caller whose input is data calls only accumulate, so
// no gradient of the input is computed.
export type Trainable<Output> = {
  readonly output: Output;
  accumulate(gradient: Output): void;
};
