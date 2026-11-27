#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';

await tsImport('./main.ts', import.meta.url);
