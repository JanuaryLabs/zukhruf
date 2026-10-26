# Startups and sizings are classes that a caller chooses

The pool came from elt, where `Vision` kept a pool of OCR processes, and `LocalTranscriptionModel` kept one transcription process. Each copy lent its workers, replaced a dead worker, killed a worker on abort, and stopped them all at the end. In trashbot, `ClaudeSupervisor` keeps one Claude process with its own queue and its own restart. Thus the pool is in this package.

Each caller had its own rules: the OCR processes first started one after the other, and the OCR caller computed how many to run from the CPUs and the free memory. A caller that decides these numbers repeats knowledge that belongs to the pool, and a change for one caller changed the pool for all of them. Thus a caller chooses a startup and a sizing from classes that the package gives, and computes nothing. A class can be added without a change to the callers.

## Considered Options

- **A number for the size, and an option for each kind of start.** Each new rule adds an option, and each caller must know how the options combine.
- **A `min` option for the workers that start with the pool.** It was added because one host wanted no workers until a command reads files. That host now builds the pool later instead: the decision is in the host, and the package keeps one rule for each startup.
