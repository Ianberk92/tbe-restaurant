// RE+ 2026 Dining Holds — Azure resources
// Deploys: Static Web App (Standard, needed for single-tenant Entra ID sign-in),
// a Storage account for Table Storage, and Application Insights for logs.
//
//   az deployment group create -g <rg> -f infra/main.bicep \
//     -p aadClientId=<app-id> aadClientSecret=<secret>
//
// The tenant ID is not a parameter here: set it in app/staticwebapp.config.json
// (openIdIssuer) before deploying the code.

@description('Name prefix for all resources (lowercase letters/numbers).')
@minLength(3)
@maxLength(12)
param prefix string = 'replusdining'

@description('Region for the Static Web App (SWA supports a limited set of regions).')
@allowed([ 'westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia' ])
param swaLocation string = 'westus2'

@description('Region for storage and monitoring.')
param location string = resourceGroup().location

@description('Entra ID app registration (client) ID used for sign-in.')
param aadClientId string

@secure()
@description('Entra ID app registration client secret.')
param aadClientSecret string

param tags object = { app: 'replus-dining-holds', owner: 'executive-office' }

var suffix = uniqueString(resourceGroup().id)

resource storage 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  name: take('${prefix}${suffix}', 24)
  location: location
  tags: tags
  sku: { name: 'Standard_ZRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true // required: SWA managed functions use a connection string
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30 }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-ai'
  location: location
  tags: tags
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id }
}

resource swa 'Microsoft.Web/staticSites@2023-01-01' = {
  name: '${prefix}-swa'
  location: swaLocation
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
    allowConfigFileUpdates: true
  }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-01-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    TABLES_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    TABLE_NAME: 'dining'
    AAD_CLIENT_ID: aadClientId
    AAD_CLIENT_SECRET: aadClientSecret
    APPLICATIONINSIGHTS_CONNECTION_STRING: insights.properties.ConnectionString
  }
}

output siteUrl string = 'https://${swa.properties.defaultHostname}'
output staticWebAppName string = swa.name
output storageAccountName string = storage.name
