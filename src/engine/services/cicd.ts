// Punto de entrada de Git y CI/CD: importa los cuatro servicios para que queden enlazados (disparadores por push).
export * as codecommit from './codecommit';
export * as codebuild from './codebuild';
export * as codepipeline from './codepipeline';
export * as codedeploy from './codedeploy';
export { cicd } from './cicdTypes';
export { settleCicd } from './codepipeline';
