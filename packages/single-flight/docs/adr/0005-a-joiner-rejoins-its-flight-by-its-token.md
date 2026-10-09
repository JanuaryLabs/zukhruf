# A joiner rejoins its flight by its token, and a call with no answer goes again as a new call

A process can lose its connection to the coordinator, for example when the coordinator stops. Its calls are then in one of three states. A call that leads has its lease, and the leader reasserts the flight. A call that joined knows which flight it joined: the answer `joined` carries the token of that flight. A call that got no answer joined nothing. The first plan sent each call of a lost connection again with `resent: true`, and a call sent again never led. A test showed the problem: at a handover, a new call that was on its way to the old coordinator got `FlightInterruptedError`, but it never joined a flight. Thus only a joiner rejoins: `{"op":"run","id":…,"key":…,"flight":"<token>"}`. The coordinator attaches a rejoin only to the flight with that token, and it answers `interrupted` when that flight is gone. A call that got no answer goes again as a new call: it waits for the grace window, and then it leads or joins.

## Considered Options

- **Each call of a lost connection goes again as resent.** A new call at a handover then fails, and that happens at each stop of a coordinator.
- **A rejoin attaches to any flight of its key.** After a second stop of a coordinator, a newer flight of the key can be in progress. A joiner of the older flight would then get the value of a flight that it never joined.
- **Only a joiner rejoins, and only by the token of its flight.** This option was selected.

## Consequences

- A joiner whose leader stopped always gets `FlightInterruptedError`. It never runs the work again.
- A call whose answer `joined` was lost with the connection goes again as a new call. If its leader stopped too, it can lead the next flight, and the work runs again. That caller never heard `onJoin`, so for it, this is a call that came after the leader stopped. A request whose answer was lost has this cost in any system that sends it again.
- A second stop of a coordinator inside one grace window ends a flight at worst as interrupted. It never gives a wrong value, and it never hangs.
