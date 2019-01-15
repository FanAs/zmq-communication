import {execSync} from "child_process"
import {hostname} from "os"

export const getSystemHost = () => {
	const host = execSync('hostname -i')
	.toString()
	.replace(/\s/gi, '');

	if (host.indexOf('127') === 0) {
		return hostname();
	}

	return host;
};