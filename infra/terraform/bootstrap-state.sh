#!/usr/bin/env bash
# One-time, idempotent: the S3 bucket that holds Riff's Terraform state.
# Terraform cannot create the bucket its own backend lives in, so this runs once before
# `terraform init`. Locking uses S3 lock files (Terraform >= 1.10), so no DynamoDB table.
set -euo pipefail
# Print AWS CLI output directly instead of opening a pager that waits for the user.
export AWS_PAGER=""
region=${AWS_REGION:-us-east-1}
account=$(aws sts get-caller-identity --query Account --output text)
bucket="riff-tfstate-$account"

if ! aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
  if [ "$region" = us-east-1 ]; then
    aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null
  else
    aws s3api create-bucket --bucket "$bucket" --region "$region" \
      --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  fi
fi
aws s3api put-bucket-versioning --bucket "$bucket" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket "$bucket" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
aws s3api put-public-access-block --bucket "$bucket" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-policy --bucket "$bucket" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"DenyInsecureTransport\", \"Effect\": \"Deny\", \"Principal\": \"*\",
    \"Action\": \"s3:*\",
    \"Resource\": [\"arn:aws:s3:::$bucket\", \"arn:aws:s3:::$bucket/*\"],
    \"Condition\": {\"Bool\": {\"aws:SecureTransport\": \"false\"}}
  }]
}"
aws s3api put-bucket-tagging --bucket "$bucket" \
  --tagging 'TagSet=[{Key=project,Value=riff},{Key=managed-by,Value=bootstrap-state.sh}]'
echo "Terraform state bucket ready: $bucket"
