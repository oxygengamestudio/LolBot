import * as play from './play.js';
import * as stop from './stop.js';
import * as pause from './pause.js';
import * as resume from './resume.js';
import * as skip from './skip.js';
import * as queue from './queue.js';
import * as join from './join.js';
import * as leave from './leave.js';
import * as settings from './settings.js';
import * as lyrics from './lyrics.js';
import * as clear from './clear.js';
import * as stats from './stats.js';
import * as seek from './seek.js';
import type { CommandDefinition } from '../types/index.js';

export const commands: CommandDefinition[] = [
    { data: play.data, execute: play.execute, autocomplete: play.autocomplete },
    { data: stop.data, execute: stop.execute },
    { data: pause.data, execute: pause.execute },
    { data: resume.data, execute: resume.execute },
    { data: skip.data, execute: skip.execute },
    { data: queue.data, execute: queue.execute },
    { data: join.data, execute: join.execute },
    { data: leave.data, execute: leave.execute },
    { data: settings.data, execute: settings.execute },
    { data: lyrics.data, execute: lyrics.execute },
    { data: clear.data, execute: clear.execute },
    { data: stats.data, execute: stats.execute },
    { data: seek.data, execute: seek.execute },
];

export { play, stop, pause, resume, skip, queue, join, leave, settings, lyrics, clear, stats, seek };
