import axios from 'axios';
import chalk from 'chalk';
import fs from 'fs';
import http from 'http';
import https from 'https';
import * as luxon from 'luxon';
import path from 'path';
import * as shared from './shared.js';

export async function writeFilesPromise(posts) {
	await writeMarkdownFilesPromise(posts);
	await writeImageFilesPromise(posts);
}

async function processPayloadsPromise(payloads, loadFunc) {
	const promises = payloads.map((payload) => new Promise((resolve, reject) => {
		setTimeout(async () => {
			try {
				const data = await loadFunc(payload);
				await writeFile(payload.destinationPath, data);
				logPayloadResult(payload);
				resolve();
			} catch (ex) {
				logPayloadResult(payload, ex.message);
				reject();
			}
		}, payload.delay);
	}));

	const results = await Promise.allSettled(promises);
	const failedCount = results.filter((result) => result.status === 'rejected').length;
	if (failedCount === 0) {
		console.log('Done, got them all!');
	} else {
		console.log('Done, but with ' + chalk.red(failedCount + ' failed') + '.');
	}
}

async function writeFile(destinationPath, data) {
	await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
	await fs.promises.writeFile(destinationPath, data);
}

async function writeMarkdownFilesPromise(posts) {
	// package up posts into payloads
	let existingCount = 0;
	let delay = 0;
	const payloads = posts.flatMap((post) => {
		const destinationPath = shared.buildPostPath(post);
		if (checkFile(destinationPath)) {
			// already exists, don't need to save again
			existingCount++;
			return [];
		} else {
			const payload = {
				item: post,
				type: post.type,
				name: shared.getSlugWithFallback(post),
				destinationPath,
				delay
			};
			delay += shared.config.writeDelay;
			return [payload];
		}
	});

	logSavingMessage('posts', existingCount, payloads.length);
	if (payloads.length > 0) {
		await processPayloadsPromise(payloads, loadMarkdownFilePromise);
	}
}

async function loadMarkdownFilePromise(payload) {
	const post = payload.item;
	let output = '---\n';

	Object.entries(post.frontmatter).forEach(([key, value]) => {
		let outputValue;
		if (Array.isArray(value)) {
			if (value.length > 0) {
				// array of one or more strings
				outputValue = value.reduce((list, item) => `${list}\n  - "${item}"`, '');
			}
		} else if (Number.isInteger(value)) {
			// output unquoted
			outputValue = value.toString();
		} else if (value instanceof luxon.DateTime) {
			if (shared.config.dateFormat) {
				outputValue = value.toFormat(shared.config.dateFormat);
			} else {
				outputValue = shared.config.includeTime ? value.toISO() : value.toISODate();
			}

			if (shared.config.quoteDate) {
				outputValue = `"${outputValue}"`;
			}
		} else if (typeof value === 'boolean') {
			// output unquoted
			outputValue = value.toString();
		} else {
			// single string value
			const escapedValue = (value ?? '').replace(/"/g, '\\"');
			if (escapedValue.length > 0) {
				outputValue = `"${escapedValue}"`;
			}
		}

		if (outputValue !== undefined) {
			output += `${key}: ${outputValue}\n`;
		}
	});

	output += `---\n\n${post.content}\n`;
	return output;
}

async function writeImageFilesPromise(posts) {
	// optional local wp-content folder, used to copy media from a local WordPress install or backup
	const wpContentPath = posts.some((post) => post.imageUrls.length > 0) ? getWpContentPath() : undefined;

	// collect image data from all posts into a single flattened array of payloads
	let existingCount = 0;
	let localCount = 0;
	let delay = 0;
	const payloads = posts.flatMap((post) => {
		const postPath = shared.buildPostPath(post);
		const imagesDir = path.join(path.dirname(postPath), 'images');
		return post.imageUrls.flatMap((imageUrl) => {
			const filename = shared.getFilenameFromUrl(imageUrl);
			const destinationPath = path.join(imagesDir, filename);
			if (checkFile(destinationPath)) {
				// already exists, don't need to save again
				existingCount++;
				return [];
			} else {
				// prefer copying from the local wp-content folder, if the image lives there
				const localPath = wpContentPath ? getLocalImagePath(imageUrl, wpContentPath) : undefined;
				if (localPath) {
					localCount++;
				}

				const payload = {
					item: imageUrl,
					type: localPath ? 'image:local' : 'image',
					name: filename,
					destinationPath,
					localPath,
					delay
				};

				if (!localPath) {
					// only space out requests that actually go over the network
					delay += shared.config.requestDelay;
				}

				return [payload];
			}
		});
	});

	logSavingMessage('images', existingCount, payloads.length);
	if (localCount > 0) {
		console.log(`${localCount} of them will be copied from the local wp-content folder.`);
	}
	if (payloads.length > 0) {
		await processPayloadsPromise(payloads, loadImageFilePromise);
	}
}

async function loadImageFilePromise(payload) {
	if (payload.localPath) {
		return fs.promises.readFile(payload.localPath);
	}

	return loadImageFromUrlPromise(payload.item);
}

async function loadImageFromUrlPromise(imageUrl) {
	// only encode the URL if it doesn't already have encoded characters
	const url = (/%[\da-f]{2}/i).test(imageUrl) ? imageUrl : encodeURI(imageUrl);

	const requestConfig = {
		method: 'get',
		url,
		headers: {
			'User-Agent': 'wordpress-export-to-markdown'
		},
		responseType: 'arraybuffer'
	};

	if (!shared.config.strictSsl) {
		// custom agents to disable SSL errors (adding both http and https, just in case)
		requestConfig.httpAgent = new http.Agent({ rejectUnauthorized: false });
		requestConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
	}

	const response = await axios(requestConfig);
	const buffer = Buffer.from(response.data, 'binary');

	return buffer;
}

function checkFile(path) {
	return fs.existsSync(path);
}

function getWpContentPath() {
	if (!shared.config.wpContent) {
		return undefined;
	}

	const absolutePath = path.resolve(shared.config.wpContent);
	try {
		if (fs.statSync(absolutePath).isDirectory()) {
			return absolutePath;
		}
	} catch (ex) {
		// fall through to the warning below
	}

	console.log(chalk.yellow(`Warning: wp-content folder not found at ${absolutePath}. Images will be downloaded instead.`));
	return undefined;
}

// maps a media URL onto a file in the local wp-content folder, if it has one
function getLocalImagePath(imageUrl, wpContentPath) {
	let pathname;
	try {
		pathname = new URL(imageUrl).pathname;
	} catch (ex) {
		return undefined;
	}

	try {
		pathname = decodeURIComponent(pathname);
	} catch (ex) {
		// improperly encoded characters, use the pathname as-is
	}

	// keep everything after the wp-content/ segment, for example uploads/2020/12/photo.jpg
	const marker = '/wp-content/';
	const markerIndex = pathname.toLowerCase().indexOf(marker);
	if (markerIndex === -1) {
		return undefined;
	}

	const segments = pathname
		.slice(markerIndex + marker.length)
		.split('/')
		.filter((segment) => segment && segment !== '.' && segment !== '..');
	if (segments.length === 0) {
		return undefined;
	}

	// the wp-content folder might have been given as the uploads folder itself
	const segmentLists = [segments];
	if (segments[0].toLowerCase() === 'uploads' && segments.length > 1) {
		segmentLists.push(segments.slice(1));
	}

	const candidates = [];
	segmentLists.forEach((list) => {
		candidates.push(path.join(wpContentPath, ...list));

		// WordPress often serves a resized copy of an image, which may be missing from a partial backup
		const resizedMatch = list[list.length - 1].match(/^(.*?)-\d+x\d+(\.[^.]+)$/);
		if (resizedMatch) {
			candidates.push(path.join(wpContentPath, ...list.slice(0, -1), resizedMatch[1] + resizedMatch[2]));
		}
	});

	return candidates.find((candidate) => checkFile(candidate));
}

function logSavingMessage(things, existingCount, remainingCount) {
	shared.logHeading(`Saving ${things}`);
	if (existingCount + remainingCount === 0) {
		console.log(`No ${things} to save.`);
	} else if (existingCount === 0) {
		console.log(`${remainingCount} ${things} to save.`);
	} else if (remainingCount === 0) {
		console.log(`All ${existingCount} ${things} already saved.`);
	} else {
		console.log(`${existingCount} ${things} already saved, ${remainingCount} remaining.`);
	}
}

function logPayloadResult(payload, errorMessage) {
	const messageBits = [
		errorMessage ? chalk.red('✗') : chalk.green('✓'),
		chalk.gray(`[${payload.type}]`),
		payload.name
	];
	if (errorMessage) {
		messageBits.push(chalk.red(`(${errorMessage})`));
	}

	console.log(messageBits.join(' '));
}
