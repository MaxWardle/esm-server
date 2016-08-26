'use strict';
// =========================================================================
//
// Controller for projects
//
// =========================================================================
var path = require('path');
var DBModel = require(path.resolve('./modules/core/server/controllers/core.dbmodel.controller'));
var Template = require(path.resolve('./modules/templates/server/controllers/template.controller'));
var ArtifactType = require('./artifact.type.controller');
var MilestoneClass = require(path.resolve('./modules/milestones/server/controllers/milestone.controller'));
var ActivityClass = require(path.resolve('./modules/activities/server/controllers/activity.controller'));
var PhaseClass = require(path.resolve('./modules/phases/server/controllers/phase.controller'));
// var Roles               = require (path.resolve('./modules/roles/server/controllers/role.controller'));
var _ = require('lodash');
var DocumentClass  = require (path.resolve('./modules/documents/server/controllers/core.document.controller'));
var Access    = require (path.resolve ('./modules/core/server/controllers/core.access.controller'));

module.exports = DBModel.extend({
	name: 'Artifact',
	plural: 'artifacts',
	populate: 'artifactType template document valuedComponents',
	bind: ['getCurrentTypes'],
	getForProject: function (projectid) {
		return this.list({project: projectid}, {
			name: 1,
			version: 1,
			stage: 1,
			isPublished: 1,
			userPermissions: 1,
			valuedComponents: 1,
			author: 1,
			shortDescription: 1,
			dateUpdated: 1,
			dateAdded: 1,
			addedBy: 1,
			updatedBy: 1
		});
	},
	// If we want artifacts that do not equal a certain type
	getForProjectFilterType: function (projectid, qs) {
		var q = {project: projectid};
		q.isPublished = qs.isPublished;
		q.typeCode = { '$nin': qs.typeCodeNe.split(',') };
		this.populate = 'artifactType template document valuedComponents addedBy updatedBy';
		return this.findMany(q, {
			name: 1,
			version: 1,
			stage: 1,
			isPublished: 1,
			userPermissions: 1,
			valuedComponents: 1,
			author: 1,
			shortDescription: 1,
			dateUpdated: 1,
			dateAdded: 1,
			addedBy: 1,
			updatedBy: 1
		});
	},
	// We want to specifically get these types
	getForProjectType: function (projectid, type) {
		return this.list({project: projectid, typeCode: type},
		{
			name: 1,
			version: 1,
			stage: 1,
			isPublished: 1,
			userPermissions: 1,
			valuedComponents: 1,
			author: 1,
			shortDescription: 1,
			dateUpdated: 1,
			dateAdded: 1,
			addedBy: 1,
			updatedBy: 1
		});
	},
	// -------------------------------------------------------------------------
	//
	// make a new artifact from a given type.
	// this will make the new artifact and put it in the first stage and the
	// first version as supplied in the type model
	// if it is of type template, then the most current version of the template
	// that matches the type will be used
	//
	// -------------------------------------------------------------------------
	newFromType: function (code, project) {
		var types = new ArtifactType(this.opts);
		var template = new Template(this.opts);
		var self = this;
		var artifactType;
		var artifact;
		var prefix = 'Add Artifact Error: ';
		return new Promise(function (resolve, reject) {
			//
			// first off, lets check and make sure that we have everything we need
			// in order to continue
			//
			// console.log ('project: ',JSON.stringify (project, null, 4));
			if (!project) return reject(new Error(prefix + 'missing project'));
			if (!project.currentPhase) return reject(new Error(prefix + 'missing current phase'));
			//
			// default a new artifact
			//
			self.newDocument().then(function (a) {
				artifact = a;
				return types.findOne({code: code});
			})
			//
			// check that we have an artifact type
			//
			.then(function (atype) {
				if (!atype) return reject(new Error(prefix + 'cannot locate artifact type'));
				else {
					artifactType = atype;
					// console.log ('getting template');
					//
					// if this is a template artifact get the latest version of the template
					//
					if (artifactType.isTemplate) return template.findFirst({code: code}, null, {versionNumber: -1});
				}
			})
			//
			// if template, check that have it as well
			//
			.then(function (t) {
				// console.log ('setting template', t);
				//
				// if its a template, but the template was not found then fail
				//
				if (artifactType.isTemplate && !t) return reject(prefix + 'cannot find template');
				//
				// otherwise set the template if required and retun the artifact for next step
				//
				else {
					// For now, only artifacts which are templates of a certain type have signatureStages.
					if (artifactType.isTemplate) {
						artifact.signatureStage = t[0].signatureStage;
					}
					artifact.template = (artifactType.isTemplate) ? t[0] : null;
					artifact.isTemplate = artifactType.isTemplate;
					artifact.isArtifactCollection = artifactType.isArtifactCollection;
					return artifact;
				}
			})
			//
			// now add the milestone associated with this artifact
			//
			.then(function (m) {
				// console.log("artifact type:",artifactType);
				// Don't add milestones for artifacts of type 'valued-component'
				if (artifactType.code === 'valued-component') {
					return null;
				}

				// not sure if this is right or we need more data on the templates...
				if (_.isEmpty(artifactType.milestone))
					return null;

				var p = new MilestoneClass(self.opts);
				return p.fromBase(artifactType.milestone, project.currentPhase);
			})
			//
			// now set up and save the new artifact
			//
			.then(function (milestone) {
				//console.log('newFromType milestone ' + JSON.stringify(milestone, null, 4));
				// Happens when we skip adding a milestone.
				if (milestone) {
					artifact.milestone = milestone._id;
				}
				artifact.typeCode = artifactType.code;
				artifact.name = artifactType.name;
				artifact.project = project._id;
				artifact.phase = project.currentPhase._id;
				artifact.artifactType = artifactType;
				artifact.version = artifactType.versions[0];
				artifact.stage = artifactType.stages[0].name;
				return artifact;
			})
			.then(function(a) {
				return self.setDefaultRoles(artifact, project, artifactType.code);
			})
			.then(function(a) {
				//console.log('newFromType call saveDocument');
				return self.saveDocument(artifact);
			})
			.then(function(a) {
				//console.log('newFromType saveDocument returns: ' + JSON.stringify(a, null, 4));
				return a;
			})
			.then(resolve, reject);
		});
	},
	setDefaultRoles: function (artifact, project, type) {
		// Set default read/write/submit permissions on artifacts based on their type.

		var permissions = {};

		switch (type) {
			case 'aboriginal-consultation':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'aboriginal-consultation-report':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'amendment-aboriginal-consultation':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'amendment-working-group':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'application':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-participant', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'application-evaluation-working-group':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'application-information-requirements':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'application-package':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'application-review-working-group':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'assesment-fee-1-fee-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'assesment-fee-2-fee-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'certificate-amendment':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'certificate-amendment-fee-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'certificate-cancellation':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'certificate-extension':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'certificate-extension-fee-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'certificate-suspension':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'decision-package':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'documents':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'project-intake', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'draft-application-information-requirements':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'environmental-assessment-certificate-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'environmental-certificate':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'evaluation-report':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'inspection-report-template':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'memo-to-the-minister-from-the-associate-deputy-minister':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'post-certififaction-inspection-fees':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'pre-application-inspection-fees':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'pre-application-working-group':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'pre-assessment-inspection-fees':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'pre-assessment-working-group':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-description':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'project-intake', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-description-template':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'project-intake', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-management-plans':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['proponent-lead', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-monitoring-plans':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['proponent-lead', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-studies':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['proponent-lead', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-termination':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'project-withdrawal':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'public-consultation-report':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'recommendations-of-the-executive-director':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'referral-package':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-a':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-a-order-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-b':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-b-fee-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-b-order-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-c':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-10-1-c-order-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-11-order-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-11-schedule-a-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-13-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-14-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-15-order':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-34-order-template':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'section-36-order-template':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'section-36-schedule-a-template':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'section-36-schedule-b-template':
				permissions = {
					'read': ['associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['compliance-lead', 'compliance-officer', 'project-system-admin'],
					'delete': ['compliance-lead', 'compliance-officer', 'project-system-admin']
				};
				break;
			case 'section-6':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'minister', 'minister-office', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-7':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'section-7-3-order-template':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'substatially-started-decision':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'substitution--decision-request':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'threshold-determination':
				permissions = {
					'read': ['assessment-admin', 'project-eao-staff', 'project-intake', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'project-intake', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'timeline-extension':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'timeline-suspension':
				permissions = {
					'read': ['assessment-admin', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'valued-component-package':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'valued-component-selection-document':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'project-qa-officer', 'compliance-lead', 'compliance-officer', 'aboriginal-group', 'project-working-group', 'project-technical-working-group', 'project-participant', 'project-system-admin'],
					'write': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
			case 'wg-consultation-report':
				permissions = {
					'read': ['proponent-lead', 'proponent-team', 'assessment-admin', 'project-eao-staff', 'assessment-lead', 'assessment-team', 'assistant-dm', 'project-epd', 'assistant-dmo', 'associate-dm', 'associate-dmo', 'compliance-lead', 'compliance-officer', 'project-working-group', 'project-technical-working-group', 'project-system-admin'],
					'write': ['proponent-lead', 'proponent-team', 'assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin'],
					'delete': ['assessment-admin', 'assessment-lead', 'assessment-team', 'project-epd', 'project-system-admin']
				};
				break;
		}

		artifact.read = permissions.read;
		artifact.write = permissions.write;
		artifact.delete = permissions.delete;


		return artifact;
	},
	// -------------------------------------------------------------------------
	//
	// return a list of avaible types based upon the table, but also what the
	// project already has.  So, any artifaacts that can only appear once,
	// such as the project description, cannot be returned if they have already
	// been established within the project
	//
	// -------------------------------------------------------------------------
	availableTypes: function (projectId) {
		//
		// get a list of all multiple types, those can be used
		// get a list of non-multiples
		// get a list of already used types in the project
		// get the disjoint of the latter two and add those to the list of available
		//
		var self = this;
		var Types = new ArtifactType(self.opts);
		var multiples = [];
		var nonmultiples = [];
		return new Promise(function (resolve, reject) {
			Types.getMultiples()
			.then(function (result) {
				// console.log (result);
				if (result) multiples = result;
				// console.log ('multiples = ', JSON.stringify(multiples,null,4));
			})
			.then(Types.getNonMultiples)
			.then(function (result) {
				// console.log (result);
				if (result) nonmultiples = result;
				// console.log ('non-multiples = ', JSON.stringify(nonmultiples,null,4));
				return projectId;
			})
			.then(self.getCurrentTypes)
			.then(function (currenttypes) {
				var allowed = [];
				if (currenttypes) {
					_.each(nonmultiples, function (val) {
						if (!~currenttypes.indexOf(val.code)) {
							allowed.push(val);
						}
					});
					// Add in the multiples
					_.each(multiples, function (item) {
						allowed.push(item);
					});
				}
				// console.log ('nallowed = ', JSON.stringify(allowed,null,4));
				return allowed;
			})
			.then(resolve, reject);
		});
	},
	// -------------------------------------------------------------------------
	//
	// get all the current types used for a project
	//
	// -------------------------------------------------------------------------
	getCurrentTypes: function (projectId) {
		// console.log ('getCurrentTypes for ', projectId);
		var self = this;
		return new Promise(function (resolve, reject) {
			self.findMany({project: projectId}, {typeCode: 1})
			.then(function (result) {
				return result.map(function (e) {
					return e.typeCode;
				});
			})
			.then(resolve, reject);
		});
	},
	// -------------------------------------------------------------------------
	//
	// these save the passed in document and then progress it to the next stage
	// doc is a json object while oldDoc is a proper mongoose schema
	//
	// -------------------------------------------------------------------------
	nextStage: function (doc, oldDoc) {
		var stage = _.find(doc.artifactType.stages, function (s) {
			return s.name === doc.stage;
		});

		console.log(stage);
		if (stage.next) {
			var next = _.find(doc.artifactType.stages, function (s) {
				return s.activity === stage.next;
			});
			return this.newStage(doc, oldDoc, next);
		}
	},
	prevStage: function (doc, oldDoc) {
		var stage = _.find(doc.artifactType.stages, function (s) {
			return s.name === doc.stage;
		});
		if (stage.prev) {
			var prev = _.find(doc.artifactType.stages, function (s) {
				return s.activity === stage.prev;
			});
			return this.newStage(doc, oldDoc, prev);
		}
	},
	newStage: function (doc, oldDoc, next) {
		doc.stage = next.name;
		// console.log (doc);
		// console.log (doc.reviewnote);
		//
		// if there is a new review note then push it
		//
		if (doc.reviewnote) {
			doc.reviewNotes.push({
				username: this.user.username,
				date: Date.now(),
				note: doc.reviewnote
			});
		}
		//
		// if there is a new approval note then push it
		//
		if (doc.approvalnote) {
			doc.approvalNotes.push({
				username: this.user.username,
				date: Date.now(),
				note: doc.approvalnote
			});
		}
		//
		// if there is a new decision note then push it
		//
		if (doc.decisionnote) {
			doc.decisionNotes.push({
				username: this.user.username,
				date: Date.now(),
				note: doc.decisionnote
			});
		}
		//
		// if this is a publish step, then publish the artifact
		//
		// doc.read = _.union (doc.read, 'public');
		// doc.isPublished = true;
		//
		// save the document
		//
		// console.log ('about to attempt to save saveDocument', doc);
		if (_.isEmpty(doc.document)) doc.document = null;

		var self = this;
		return this.update(oldDoc, doc)
			.then(function (model) {
				//
				// once saved go and create the new activity if one is listed under
				// this stage
				//
				// console.log ('document saved, now add the activity ', model.milestone, next.activity);
				if (model.milestone && next.activity) {
					var ativity;
					var m = new MilestoneClass(self.opts);
					var a = new ActivityClass(self.opts);
					return m.findById(model.milestone)
						.then(function (milestone) {
							// console.log ('found the milestone, now adding attivity');
							//
							// this is where we should/would set special permisions, but they
							// really should be on the default base activity (which this does do)
							//
							return a.fromBase(next.activity, milestone, {artifactId: model._id});
						})
						.then(function () {
							return model;
						});
				} else {
					return model;
				}
			});
	},
	// -------------------------------------------------------------------------
	//
	// this gets the most current version of each artifact
	//
	// -------------------------------------------------------------------------
	currentArtifacts: function () {
		var self = this;
		return new Promise(function (resolve, reject) {
			self.model.aggregate([
				{"$sort": {"versionNumber": -1}},
				{
					"$group": {
						"_id": "$typeCode",
						"id": {"$first": "$_id"},
						"name": {"$first": "$name"},
						"documentType": {"$first": "$typeCode"},
						"versionNumber": {"$first": "$versionNumber"},
						"dateUpdated": {"$first": "$dateUpdated"},
						"stage": {"$first": "$stage"}
					}
				}
			], function (err, result) {
				if (err) return reject(err);
				else resolve(result);
			});
		});
	},
	// -------------------------------------------------------------------------
	//
	// create a new version of the supplied artifact in the passed in project
	// in its current phase.
	//
	// -------------------------------------------------------------------------
	createNewArtifactInProject: function (type, project) {

	},
	// -------------------------------------------------------------------------
	//
	// for the given artifact, assumed already created in a base form, create
	// the initial activity set using the milestonebase attached to the artifact
	// meta
	//
	// -------------------------------------------------------------------------
	createMilestoneForArtifact: function (artifact) {

	},
	// -------------------------------------------------------------------------
	//
	// publish / unpublish
	//
	// -------------------------------------------------------------------------
	publish: function (artifact) {
		var documentClass = new DocumentClass(this.opts);
		return new Promise(function (resolve, reject) {
			artifact.publish();
			artifact.save()
				.then(function () {
					// publish document, additionalDocuments, supportingDocuments
					//console.log('documentClass.publish(artifact.document): ' + JSON.stringify(artifact.document, null, 4));
					return documentClass.publish(artifact.document);
				})
				.then(function () {
					return documentClass.getListIgnoreAccess(artifact.additionalDocuments);
				})
				.then(function (list) {
					//console.log('documentClass.publishList(artifact.additionalDocuments): ' + JSON.stringify(list, null, 4));
					var a = _.forEach(list, function (d) {
						return new Promise(function (resolve, reject) {
							resolve(documentClass.publish(d));
						});
					});
					return Promise.all(a);
				})
				.then(function () {
					return documentClass.getListIgnoreAccess(artifact.supportingDocuments);
				})
				.then(function (list) {
					//console.log('documentClass.publishList(artifact.supportingDocuments): ' + JSON.stringify(list, null, 4));
					var a = _.forEach(list, function (d) {
						return new Promise(function (resolve, reject) {
							resolve(documentClass.publish(d));
						});
					});
					return Promise.all(a);
				})
				.then(function () {
					return documentClass.getListIgnoreAccess(artifact.internalDocuments);
				})
				.then(function (list) {
					//console.log('documentClass.unpublishList(artifact.internalDocuments): ' + JSON.stringify(list, null, 4));
					var a = _.forEach(list, function (d) {
						return new Promise(function (resolve, reject) {
							resolve(documentClass.unpublish(d));
						});
					});
					return Promise.all(a);
				})
				.then(function () {
					//console.log('< save()');
					return artifact;
				})
				.then(resolve, reject);
		});
	},
	unpublish: function (artifact) {
		var documentClass = new DocumentClass(this.opts);
		return new Promise(function (resolve, reject) {
			artifact.unpublish();
			artifact.save()
				.then(function () {
					// publish document, additionalDocuments, supportingDocuments
					//console.log('documentClass.unpublish(artifact.document): ' + JSON.stringify(artifact.document, null, 4));
					return documentClass.unpublish(artifact.document);
				})
				.then(function () {
					return documentClass.getListIgnoreAccess(artifact.additionalDocuments);
				})
				.then(function (list) {
					//console.log('documentClass.unpublishList(artifact.additionalDocuments): ' + JSON.stringify(list, null, 4));
					var a = _.forEach(list, function (d) {
						return new Promise(function (resolve, reject) {
							resolve(documentClass.unpublish(d));
						});
					});
					return Promise.all(a);
				})
				.then(function () {
					return documentClass.getListIgnoreAccess(artifact.supportingDocuments);
				})
				.then(function (list) {
					//console.log('documentClass.unpublishList(artifact.supportingDocuments): ' + JSON.stringify(list, null, 4));
					var a = _.forEach(list, function (d) {
						return new Promise(function (resolve, reject) {
							resolve(documentClass.unpublish(d));
						});
					});
					return Promise.all(a);
				})
				.then(function () {
					return documentClass.getListIgnoreAccess(artifact.internalDocuments);
				})
				.then(function (list) {
					//console.log('documentClass.unpublishList(artifact.internalDocuments): ' + JSON.stringify(list, null, 4));
					var a = _.forEach(list, function (d) {
						return new Promise(function (resolve, reject) {
							resolve(documentClass.unpublish(d));
						});
					});
					return Promise.all(a);
				})
				.then(function () {
					//console.log('< save()');
					return artifact;
				})
				.then(resolve, reject);
		});
	},
	checkPermissions: function(artifactId) {
		var self = this;

		return self.findById(artifactId)
			.then(function(artifact) {
				var permissions = {};
				artifact.artifactType.stages.forEach(function(stage) {
					permissions[stage.name] = (!stage.role) ? true : _.includes(self.opts.userRoles, stage.role);
				});

				return permissions;
			});
	}
});
