#!/usr/bin/env node
import { slugify } from '../dist/index.js';
const input = process.argv.slice(2).join(' ') || 'Hello Lemonize';
console.log(slugify(input));
