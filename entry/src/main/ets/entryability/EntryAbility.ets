import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { DemoOffline } from '../data/DemoOffline';
export default class EntryAbility extends UIAbility {
  onCreate(): void { DemoOffline.create(this.context).catch(() => console.error('DEMO_SDK_CREATE')); }
  onForeground(): void { DemoOffline.setForeground(true); }
  onBackground(): void { DemoOffline.setForeground(false); }
  onWindowStageCreate(stage: window.WindowStage): void {
    stage.loadContent('pages/Index', (error) => {
      if (error.code) { console.error('Unable to load demo page: ' + error.code); }
    });
  }
}
