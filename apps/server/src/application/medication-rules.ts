export function medicationDoseAndFrequencyAllowed(config: { allowedDoseTexts: readonly string[]; allowedFrequencyCodes: readonly string[] }, doseText: string, frequencyCode: string): boolean {
  return config.allowedDoseTexts.includes(doseText) && config.allowedFrequencyCodes.includes(frequencyCode)
}
