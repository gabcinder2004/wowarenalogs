import type { MatchSummaryRow, WowVersion } from '@wowarenalogs/parser';
import { BrowserWindow } from 'electron';

import { moduleFunction, NativeBridgeModule, nativeBridgeModule } from '../../module';
import * as Database from './database';

@nativeBridgeModule('db')
export class DbModule extends NativeBridgeModule {
  @moduleFunction()
  public async insertMatch(
    _mainWindow: BrowserWindow,
    summary: MatchSummaryRow,
    rawText: string,
  ): Promise<{ inserted: boolean }> {
    return Database.insertMatch(summary, rawText);
  }

  @moduleFunction()
  public async getMatchesSince(_mainWindow: BrowserWindow, sinceMs: number, bracket?: string): Promise<unknown[]> {
    return Database.getMatchesSince(sinceMs, bracket);
  }

  @moduleFunction()
  public async getMatchById(_mainWindow: BrowserWindow, id: string): Promise<unknown> {
    return Database.getMatchById(id);
  }

  @moduleFunction()
  public async getRawSlice(
    _mainWindow: BrowserWindow,
    id: string,
  ): Promise<{ rawText: string; wowVersion: WowVersion; timezone: string } | null> {
    return Database.getRawSlice(id) as { rawText: string; wowVersion: WowVersion; timezone: string } | null;
  }

  @moduleFunction()
  public async getDbStats(_mainWindow: BrowserWindow): Promise<{
    totalMatches: number;
    totalRawBytes: number;
    oldest: number | null;
    newest: number | null;
  }> {
    return Database.getDbStats();
  }

  public override onRegistered(_mainWindow: BrowserWindow): void {
    Database.getDb();
  }
}
