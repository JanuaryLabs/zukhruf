import { Service } from '../service.ts';

export class Microphone extends Service {
  readonly name = 'kTCCServiceMicrophone';
  readonly pane = 'Microphone';
  protected readonly anchor = 'Privacy_Microphone';
}
