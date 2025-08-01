/**
 * Parses SAC metadata into structured dimensions and measures.
 * @param {Object} metadata - The metadata object from SAC data binding.
 * @returns {Object} An object containing parsed dimensions, measures, and their mappings.
 */
export function parseMetadata(metadata) {
    const { dimensions: dimensionsMap, mainStructureMembers: measuresMap } = metadata;

    const dimensions = [];
    for (const key in dimensionsMap) {
        const dimension = dimensionsMap[key];
        dimensions.push({ key, ...dimension });
    }

    const measures = [];
    for (const key in measuresMap) {
        const measure = measuresMap[key];
        measures.push({ key, ...measure });
    }
    
    return { dimensions, measures, dimensionsMap, measuresMap };
}