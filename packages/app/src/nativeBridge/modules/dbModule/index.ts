import { BrowserWindow } from 'electron';

import { moduleFunction, NativeBridgeModule, nativeBridgeModule } from '../../module';

@nativeBridgeModule('db')
export class DbModule extends NativeBridgeModule {
  @moduleFunction()
  public async ping(_mainWindow: BrowserWindow): Promise<string> {
    return 'pong';
  }

  public override onRegistered(_mainWindow: BrowserWindow): void {
    // DB will be opened in a later task
  }
}
