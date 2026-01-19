export function uuidToBytes16(uuid) {
	// accepts "01890f2f-3c8b-7a60-a2e2-9b1d3f5d7c6b" or hex without hyphens
	const clean = uuid.toLowerCase().replace(/-/g, "");
	if (!/^([0-9a-f]{32})$/.test(clean)) throw new Error("Invalid UUID hex");
	return "0x" + clean;
	// return clean;
}
