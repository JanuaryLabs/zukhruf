import { Service } from '../service.ts';

export class SpeechRecognition extends Service {
  readonly name = 'kTCCServiceSpeechRecognition';
  readonly pane = 'Speech Recognition';
  protected readonly anchor = 'Privacy_SpeechRecognition';
}
