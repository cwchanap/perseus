import * as cloudflare from '@pulumi/cloudflare';
import { naming, accountId } from './config.js';

export function createR2Bucket() {
	return new cloudflare.R2Bucket('puzzles-bucket', {
		accountId: accountId,
		name: naming.r2Bucket
	});
}

export function createKVNamespace() {
	return new cloudflare.WorkersKvNamespace('puzzle-metadata', {
		accountId: accountId,
		title: naming.kvNamespace
	});
}
