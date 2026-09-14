import { PlatformIntegration } from '../src/platform-integration'
import { OTTIntegrationNew } from '../src/ott-integration-new'

const platformIntegration: PlatformIntegration = new OTTIntegrationNew('', {
  headless: false,
  executablePath: '',
})
