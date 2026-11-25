import { JxaRequest } from '../native/jxa-request.ts';
import { ObjectiveCClass } from '../native/objective-c-class.ts';
import { PromptedService } from '../prompted-service.ts';

// SFSpeechRecognizerAuthorizationStatus (Speech/SFSpeechRecognizer.h:25-39):
// Denied is 1 and Restricted is 2, unlike the other frameworks.
const values = ['notDetermined', 'denied', 'restricted', 'authorized'] as const;
type SpeechStatus = (typeof values)[number];

export class SpeechRecognition extends PromptedService<SpeechStatus> {
  readonly name = 'kTCCServiceSpeechRecognition';
  readonly pane = 'Speech Recognition';
  protected readonly anchor = 'Privacy_SpeechRecognition';

  protected readonly requestScript = JxaRequest.decided(
    ['Speech'],
    "C('SFSpeechRecognizer').requestAuthorization(() => {});",
    "Number(C('SFSpeechRecognizer').authorizationStatus) === 0",
  ).source;

  status(): SpeechStatus {
    return this.named(
      values,
      new ObjectiveCClass(
        '/System/Library/Frameworks/Speech.framework/Speech',
        'SFSpeechRecognizer',
      ).integer('authorizationStatus'),
    );
  }
}
